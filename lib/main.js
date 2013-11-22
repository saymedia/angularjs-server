'use strict';

var url = require('url');
var angularcontext = require('angularcontext');
var ngoverrides = require('./ngoverrides.js');
var escapeHtml = require('escape-html');

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

function getInjector(context, modules, request) {
    modules = context.getAngular().copy(modules);
    modules.unshift('angularjs-server');

    var injector = context.injector(modules);

    var reqContext = injector.get('serverRequestContext');
    reqContext.setRequest(request);

    return injector;
}

// Takes an object that may contain promises as values, and returns a single
// promise that resolves only when all of the promises are resolved. Recursively
// flattens promises in descendent objects too. The finished data structure is guaranteed
// not to contain any promises, only promise results.
function flattenPromises($q, obj) {
    var defer = $q.defer();

    var outstandingPromises = 0;

    var maybeDone = function () {
        if (outstandingPromises === 0) {
            defer.resolve(obj);
        }
    };

    var flattenKey = function (obj, k, v) {
        if (v && typeof v.then === 'function') {
            outstandingPromises++;
            v.then(
                function (nextV) {
                    outstandingPromises--;
                    flattenKey(obj, k, nextV);
                }
            );
        }
        else {
            obj[k] = v;
            if (typeof v === 'object') {
                flattenObj(v);
            }
            maybeDone();
        }
    };

    var flattenObj = function (obj) {
        for (var k in obj) {
            flattenKey(obj, k, obj[k]);
        }
    };

    flattenObj(obj);

    maybeDone();

    return defer.promise;
}

function resolveRoute(injector, path, search) {
    var $route = injector.get('$route');

    var route = $route.getByPath(path, search);
    if (! route) {
        return null;
    }
    route.locals = route.locals || {};
    var prevRoute = $route.current;
    $route.current = route;
    if (route.resolve) {
        for (var k in route.resolve) {
            var resolver = route.resolve[k];
            if (typeof resolver === 'string') {
                route.locals[k] = injector.get(resolver);
            }
            else {
                route.locals[k] = injector.invoke(resolver);
            }
        }
    }
    $route.current = prevRoute;
    // FIXME: Support templateUrl here? That would make this function async,
    // so maybe not worth the trouble.
    route.locals.$template = route.template;
    return route;
}

function makeJsonFriendlyRoute(injector, route) {
    var $q = injector.get('$q');
    var defer = $q.defer();

    var locals = {};
    var localServices = {};
    if (route.resolve) {
        for (var k in route.resolve) {
            var resolver = route.resolve[k];
            if (typeof resolver === 'string') {
                // they want to inject a service, which we can't do on the server
                // so we'll defer to the client.
                localServices[k] = resolver;
            }
            else {
                locals[k] = route.locals[k];
            }
        }
    }

    flattenPromises(
        $q,
        locals
    ).then(
        function (locals) {
            defer.resolve(
                {
                    path: route.originalPath,
                    controller: route.controller,
                    template: route.template,
                    templateUrl: route.templateUrl,
                    locals: locals,
                    localServices: localServices,
                    pathParams: route.pathParams
                }
            );
        },
        function (err) {
            defer.reject(err);
        }
    );

    return defer.promise;
}

function middlewareWithAngular(func, serverScripts, prepContext) {

    return function (request, response, next) {
        var context = angularcontext.Context();
        context.runFiles(
            serverScripts,
            function (success, error) {
                if (error) {
                    sendError(error, response);
                    context.dispose();
                    return;
                }

                ngoverrides.registerModule(context);
                prepContext(
                    context,
                    function () {
                        try {
                            func(request, response, next, context);
                        }
                        catch (err) {
                            context.dispose();
                            sendError(err, response);
                        }
                    }
                );
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
        function (request, response, next, context) {
            modules = context.getAngular().copy(modules);
            var element = context.element(template);
            modules.push(
                function ($provide) {
                    $provide.value('$rootElement', element);
                }
            );
            var injector = getInjector(context, modules, request);

            var $compile = injector.get('$compile');
            var $rootScope = injector.get('$rootScope');
            var $httpBackend = injector.get('$httpBackend');
            var $route = injector.get('$route');

            var link = $compile(element);
            link($rootScope);

            var reqContext = injector.get('serverRequestContext');
            var path = reqContext.location.path();
            var search = reqContext.location.search();

            var matchedRoute = resolveRoute(injector, path, search);

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
                makeJsonFriendlyRoute(injector, matchedRoute).then(
                    function (retRoute) {

                        // JSON stringification will fail if the resolve function produces
                        // something we can't serialize as JSON.
                        try {
                            var jsonRetRoute = JSON.stringify(retRoute);
                        }
                        catch (e) {
                            response.writeHead(500);
                            response.end('Route data could not be rendered as JSON');
                            context.dispose();
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
                        response.writeHead(200);
                        response.write(preResolvedHtml + initShim);
                        response.write('\n');

                        $rootScope.$broadcast(
                            '$routeChangeSuccess',
                            matchedRoute,
                            undefined
                        );

                        $httpBackend.notifyWhenNoOpenRequests(
                            function () {
                                $rootScope.$digest();

                                var container = context.element('<div></div>');
                                container.append(element);

                                // We remove all scripts from the snapshot, because the snapshot
                                // is intended for browsers that don't support JS and also this
                                // avoids us accidentally terminating our "hideShim" script that
                                // makes the HTML snapshot to JS-aware browsers.
                                container.find('script').remove();

                                var staticSnapshot = container.html();
                                container = null;

                                response.end(hideShim + staticSnapshot);
                                context.dispose();
                            },
                            function (error) {
                                sendError(error, response);
                                context.dispose();
                            }
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
        prepContext
    );

}

function makeSdrApi(serverScripts, prepContext, modules) {

    return middlewareWithAngular(
        function (request, response, next, context) {
            var injector = getInjector(context, modules, request);

            var reqContext = injector.get('serverRequestContext');
            var path = reqContext.location.path();
            var search = reqContext.location.search();

            var matchedRoute = resolveRoute(injector, path, search);

            if (matchedRoute) {
                makeJsonFriendlyRoute(injector, matchedRoute).then(
                    function (retRoute) {
                        var ret = {};

                        ret.route = retRoute;

                        // JSON stringification will fail if the resolve function produces
                        // something we can't serialize as JSON.
                        try {
                            var jsonRet = JSON.stringify(ret);
                        }
                        catch (e) {
                            response.writeHead(500);
                            response.end('Route data could not be rendered as JSON');
                            context.dispose();
                            return;
                        }

                        response.writeHead(200);
                        response.end(jsonRet);
                        context.dispose();
                    },
                    function (error) {
                        response.writeHead(200);
                        response.end('{}');
                        context.dispose();
                    }
                );
            }
            else {
                response.writeHead(200);
                response.end('{}');
                context.dispose();
            }
        },
        serverScripts,
        prepContext
    );

}

function makeMiddlewares(options) {
    var template = options.template;
    var serverScripts = options.serverScripts;
    var prepContext = options.prepContext || function () {};
    var clientScripts = options.clientScripts || [];
    var angularModules = options.angularModules;

    return {
        htmlGenerator: makeHtmlGenerator(serverScripts, prepContext, clientScripts, template, angularModules),
        sdrApi: makeSdrApi(serverScripts, prepContext, angularModules)
    };

}

exports.middlewares = makeMiddlewares;
