'use strict';

var url = require('url');
var angularcontext = require('angularcontext');
var ngoverrides = require('./ngoverrides.js');
var escapeHtml = require('escape-html');
var XMLHttpRequest = require('local-xmlhttprequest').XMLHttpRequest;

function sendError(error, response) {
    console.error(error.stack);
    response.writeHead(
        500,
        {
            'Content-Type': 'text/plain'
        }
    );
    response.end(
        error.stack
    );
}

function makeRunInContext(serverScripts, angularModules, prepContext, template) {
    return function (func) {
        var context = angularcontext.Context(template);
        context.setGlobal('XMLHttpRequest', XMLHttpRequest);
        context.runFiles(
            serverScripts,
            function (success, error) {
                if (error) {
                    context.dispose();
                    func(undefined, error);
                }

                prepContext(
                    context,
                    function () {

                        ngoverrides.registerModule(context);

                        var angular = context.getAngular();

                        var modules = angular.copy(angularModules);
                        modules.unshift('angularjs-server');
                        modules.unshift('ng');

                        var $injector = context.injector(modules);

                        // Although the called module will primarily use the injector, we
                        // also give it indirect access to the angular object so it can
                        // make use of Angular's "global" functions.
                        $injector.angular = angular;

                        // The caller must call this when it's finished in order to free the context.
                        $injector.close = function () {
                            context.dispose();
                        };

                        func($injector);
                    }
                );
            }
        );
    };
}

function middlewareWithAngular(func, serverScripts, angularModules, prepContext, template) {

    var runInContext = makeRunInContext(serverScripts, angularModules, prepContext, template);

    return function (request, response, next) {
        // need to tell the context its absolute base URL so that relative paths will work as expected.
        var contextUrl = request.protocol + '://' + request.get('host') + request.url;
        runInContext(
            function ($injector, error) {
                if (error) {
                    sendError(error, response);
                    return;
                }

                // Set window.location.href so that things that go directly to that layer will
                // work as expected.
                // However, we leave the context's *base* URL set to the default file:// URL,
                // since otherwise we can't make xmlhttprequest requests to the filesystem.
                var window = $injector.get('$window');
                if (window.location) {
                    window.location.href = contextUrl;
                }

                // Tell the context about our current request, so $location will work.
                var reqContext = $injector.get('serverRequestContext');
                reqContext.setRequest(request);

                // Override the end() method so that we can automatically dispose the
                // context when the request ends.
                var previousEnd = response.end;
                response.end = function () {
                    previousEnd.apply(this, arguments);
                    $injector.close();
                };

                func(request, response, next, $injector);
            }
        );
    };
}

function makeHtmlGenerator(serverScripts, prepContext, clientScripts, template, modules) {
    // starts as an array, and then flattened into a string below
    var initShim = [];
    initShim.push('<script>');
    initShim.push('document.write(');
    // FIXME: this fails if the template contains a </script> tag,
    // because JSON.stringify doesn't escape that.
    initShim.push(JSON.stringify(template));
    initShim.push(');');
    for (var i = 0; i < clientScripts.length; i++) {
        var scriptUrl = url.resolve('/static/', clientScripts[i]);
        initShim.push('document.write(\'<script src="');
        initShim.push(escapeHtml(scriptUrl));
        initShim.push('"></scr\'+\'ipt>\');');
    }
    initShim.push('</script>');
    initShim = initShim.join('');

    // Try to envelop the rest of the document in a script, so the browser won't render it.
    // This is separated from the initShim because we wait until we have rendered the HTML snapshot
    // before we'll return it, so the browser won't block rendering waiting for the end of this
    // never-ending script tag.
    var hideShim = '<script>document.write("<script type=\'dummy/x-hide-document\'>")</script>';

    return middlewareWithAngular(
        function (request, response, next, injector) {
            // bootstrap the injector against the root element
            injector.bootstrap();

            var $rootScope = injector.get('$rootScope');
            var $httpBackend = injector.get('$httpBackend');
            var $route = injector.get('$route');
            var element = injector.get('$rootElement');

            var reqContext = injector.get('serverRequestContext');
            var path = reqContext.location.path();
            var search = reqContext.location.search();

            var matchedRoute = $route.getByPath(path, search);

            if (matchedRoute) {
                // just in case the app depends on this event to do some cleanup/initialization
                $route.current = matchedRoute;
                $rootScope.$broadcast(
                    '$routeChangeStart',
                    matchedRoute,
                    undefined
                );
                $rootScope.$digest();
                // making a JSON-friendly route has the side-effect of waiting for all of
                // the route locals to resolve, which we're depending on here.
                // Right now this actually flattens the promises in the route locals as a side-effect,
                // which may or may not be a problem. Keeping it this way for now because at least it
                // means the controller running on the server will see the same thing as the controller
                // running on the client when we're using server-defined routes.
                matchedRoute.jsonFriendly().then(
                    function (retRoute) {

                        // JSON stringification will fail if the resolve function produces
                        // something we can't serialize as JSON.
                        var jsonRetRoute;
                        try {
                            jsonRetRoute = JSON.stringify(retRoute);
                        }
                        catch (e) {
                            response.writeHead(500);
                            response.end('Route data could not be rendered as JSON');
                            return;
                        }

                        var preResolvedHtml = [
                            '<script>var initialRoute = ',
                            // FIXME: this fails if the template contains a </script> tag,
                            // because JSON.stringify doesn't escape that.
                            jsonRetRoute,
                            '</script>'
                        ].join('');

                        // Return the part of the response that browsers care about as soon as it's
                        // ready. Then we'll generate the robot-oriented snapshot below.
                        // Of course this doesn't really help any when the client is getting this
                        // data from a reverse-proxy cache in front of the app, but it allows the
                        // page to start rendering sooner if we're talking directly to a browser.
                        response.set('Content-Type', 'text/html; charset=utf-8');
                        response.writeHead(200);
                        response.write(preResolvedHtml + initShim);
                        response.write('\n');

                        $rootScope.$on(
                            '$viewContentLoaded',
                            function () {
                                $httpBackend.notifyWhenNoOpenRequests(
                                    function () {
                                        $rootScope.$digest();

                                        var container = injector.angular.element('<div></div>');
                                        container.append(element);

                                        // We remove all scripts from the snapshot, because the snapshot
                                        // is intended for browsers that don't support JS and also this
                                        // avoids us accidentally terminating our "hideShim" script that
                                        // makes the HTML snapshot to JS-aware browsers.
                                        container.find('script').remove();

                                        var staticSnapshot = container.html();
                                        container = null;

                                        response.end(hideShim + staticSnapshot);
                                    }
                                );
                            }
                        );

                        $rootScope.$broadcast(
                            '$routeChangeSuccess',
                            matchedRoute,
                            undefined
                        );
                    }
                );
            }
            else {
                // TODO: render the 'otherwise' route as the 404 response body.
                response.writeHead(404);
                response.end('Not found');
            }
        },
        serverScripts,
        modules,
        prepContext,
        template
    );

}

function makeSdrApi(serverScripts, prepContext, modules) {

    return middlewareWithAngular(
        function (request, response, next, injector) {
            var reqContext = injector.get('serverRequestContext');
            var path = reqContext.location.path();
            var search = reqContext.location.search();
            var $route = injector.get('$route');

            var matchedRoute = $route.getByPath(path, search);

            if (matchedRoute) {
                matchedRoute.jsonFriendly().then(
                    function (retRoute) {
                        var ret = {};

                        ret.route = retRoute;

                        // JSON stringification will fail if the resolve function produces
                        // something we can't serialize as JSON.
                        var jsonRet;
                        try {
                            jsonRet = JSON.stringify(ret);
                        }
                        catch (e) {
                            response.writeHead(500);
                            response.end('Route data could not be rendered as JSON');
                            return;
                        }

                        response.writeHead(200);
                        response.end(jsonRet);
                    },
                    function (error) {
                        response.writeHead(200);
                        response.end('{}');
                    }
                );
            }
            else {
                response.writeHead(200);
                response.end('{}');
            }
        },
        serverScripts,
        modules,
        prepContext,
        // don't actually need a template for the SDR API, but
        // need to provide enough DOM that AngularJS can find the document and the body.
        '<html><head></head><body></body></html>'
    );

}

function makeInstance(options) {
    var template = options.template;
    var serverScripts = options.serverScripts;
    var prepContext = options.prepContext || function (context, callback) { callback(); };
    var clientScripts = options.clientScripts || [];
    var angularModules = options.angularModules || [];

    return {
        htmlGenerator: makeHtmlGenerator(serverScripts, prepContext, clientScripts, template, angularModules),
        sdrApi: makeSdrApi(serverScripts, prepContext, angularModules),
        wrapMiddlewareWithAngular: function (func) {
            return middlewareWithAngular(func, serverScripts, angularModules, prepContext, template);
        },
        runInContext: makeRunInContext(serverScripts, angularModules, prepContext, template)
    };

}

exports.Server = makeInstance;
