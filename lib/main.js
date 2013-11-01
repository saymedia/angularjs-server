
var http = require('http');
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

// old, not used
function makeRequestListener(options) {

    var template = options.template;
    var serverScripts = options.serverScripts;
    var clientScripts = options.clientScripts || [];
    var angularModules = options.angularModules;

    var initShim = [];
    initShim.push('<script type="text/javascript">setTimeout(function () {');
    initShim.push('document.open();document.write(');
    initShim.push(JSON.stringify(template));
    initShim.push(');');
    for (var i = 0; i < clientScripts.length; i++) {
        var scriptUrl = url.resolve('/static/', clientScripts[i]);
        initShim.push('document.write(\'<script type="text/javascript" src="');
        initShim.push(escapeHtml(scriptUrl));
        initShim.push('"></scr\'+\'ipt>\');');
    }
    initShim.push('document.close();}, 1);</script>');
    initShim = initShim.join('');

    return function (request, response) {
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

                handleRequest(template, context, angularModules, initShim, request, response);
            }
        );
    };
}

// old, not used
function handleRequest(template, context, modules, initShim, request, response) {

    try {
        modules = context.getAngular().copy(modules);
        var element = context.element(template);
        modules.push(
            function ($provide) {
                $provide.value('$rootElement', element);
            }
        );
        modules.push('angularjs-server');

        var injector = context.injector(modules);
        var reqContext = injector.get('serverRequestContext');
        reqContext.setRequest(request);

        var $compile = injector.get('$compile');
        var $rootScope = injector.get('$rootScope');
        var $httpBackend = injector.get('$httpBackend');

        var link = $compile(element);
        link($rootScope);

        var onceRouteKnown = function (route) {

            if (reqContext.getRedirectTo()) {
                // The path changed while we were rendering, so emit a redirect.
                // FIXME: Find some way to do this without actually doing the work to render
                // the route. Probably will need to do route resolution manually, then.
                response.writeHead(
                    302,
                    {
                        Location: reqContext.getRedirectTo()
                    }
                );
                response.end(reqContext.getRedirectTo());
                // still need to clean up the context once everything's settled.
                $httpBackend.notifyWhenNoOpenRequests(
                    function () {
                        context.dispose();
                    }
                );
                return;
            }

            // Stash any controller locals we pre-resolved so we can return them
            // to the client as a sort of cache so the browser can avoid additional round-trips.
            var preResolved = {};
            if (route.$$route && route.$$route.resolve) {
                for (var k in route.$$route.resolve) {
                    if (route.locals[k] !== undefined) {
                        // TODO: Walk the tree and flatten any promises in there?
                        // Promises won't survive our JSON marshalling so we need
                        // to replace them with their value if we want to
                        // use nested promises in our resolve steps.
                        preResolved[k] = route.locals[k];
                    }
                }
            }

            $httpBackend.notifyWhenNoOpenRequests(
                function () {
                    $rootScope.$digest();

                    var container = context.element('<div></div>');
                    container.append(element);

                    var staticSnapshot = container.html();
                    container = null;

                    var initialRoute = {
                        template: route.template,
                        controller: route.controller,
                        locals: preResolved
                    };

                    var preResolvedHtml = [
                        '<script>var initialRoute = ',
                        JSON.stringify(initialRoute),
                        '</script>'
                    ].join('');

                    response.writeHead(200);
                    response.end(initShim + preResolvedHtml + staticSnapshot);
                    context.dispose();
                }
            );
        };

        $rootScope.$on(
            '$routeChangeSuccess',
            function (evt, newRoute, oldRoute) {
                onceRouteKnown(newRoute);
            }
        );

        // return a real 404 if we fail to change routes
        $rootScope.$on(
            '$routeChangeError',
            function (evt, newRoute, oldRoute, rejection) {
                // TODO: Come up with a way to let the app customize the 404 page.
                response.writeHead(404);
                response.end('Not Found');
            }
        );

        // Kick off the route system by broadcasting our URL.
        $rootScope.$broadcast(
            '$locationChangeSuccess',
            reqContext.location.absUrl(),
            undefined
        );
        $rootScope.$digest();

    }
    catch (err) {
        context.dispose();
        sendError(err, response);
    }
}

function getInjector(context, modules, request) {
    modules = context.getAngular().copy(modules);
    modules.unshift('angularjs-server');

    var injector = context.injector(modules);

    var reqContext = injector.get('serverRequestContext');
    reqContext.setRequest(request);

    return injector;
}

function resolveRoute(injector, path, search) {
    var $route = injector.get('$route');
    var $q = injector.get('$q');
    var defer = $q.defer();

    var matchedRoute = $route.getByPath(path, search);
    if (matchedRoute) {
        var locals = {};
        var localServices = {};
        if (matchedRoute.resolve) {
            for (k in matchedRoute.resolve) {
                var resolver = matchedRoute.resolve[k];
                if (typeof resolver === "string") {
                    // they want to inject a service, which we can't do on the server
                    // so we'll defer to the client.
                    localServices[k] = resolver;
                }
                else {
                    locals[k] = injector.invoke(resolver);
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
                        controller: matchedRoute.controller,
                        template: matchedRoute.template,
                        templateUrl: matchedRoute.templateUrl,
                        locals: locals,
                        localServices: localServices
                    }
                );
            },
            function (err) {
                defer.reject(err);
            }
        );
    }
    else {
        defer.reject(new Error("no matching route"));
    }

    return defer.promise;
}

function middlewareWithAngular(func, serverScripts) {

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
                func(request, response, next, context);
            }
        );
    };

};

function makeHtmlGenerator(serverScripts, clientScripts, template, modules) {

    // starts as an array, and then flattened into a string below
    var initShim = [];
    initShim.push('<script type="text/javascript">setTimeout(function () {');
    initShim.push('document.open();document.write(');
    initShim.push(JSON.stringify(template));
    initShim.push(');');
    for (var i = 0; i < clientScripts.length; i++) {
        var scriptUrl = url.resolve('/static/', clientScripts[i]);
        initShim.push('document.write(\'<script type="text/javascript" src="');
        initShim.push(escapeHtml(scriptUrl));
        initShim.push('"></scr\'+\'ipt>\');');
    }
    initShim.push('document.close();}, 1);</script>');
    initShim = initShim.join('');

    return middlewareWithAngular(
        function (request, response, next, context) {
            response.writeHead(200);
            response.end('html generator TBD');
        },
        serverScripts
    );

}

function makeSdrApi(serverScripts, modules) {

    return middlewareWithAngular(
        function (request, response, next, context) {
            var injector = getInjector(context, modules, request);

            var reqContext = injector.get('serverRequestContext');
            var path = reqContext.location.path();
            var search = reqContext.location.search();

            resolveRoute(injector, path, search).then(
                function (matchedRoute) {
                    var ret = {};

                    if (matchedRoute) {
                        ret.route = matchedRoute;
                    }

                    response.writeHead(200);
                    response.end(JSON.stringify(ret));
                }
            );
        },
        serverScripts
    );

}

function makeMiddlewares(options) {
    var template = options.template;
    var serverScripts = options.serverScripts;
    var clientScripts = options.clientScripts || [];
    var angularModules = options.angularModules;

    return {
        htmlGenerator: makeHtmlGenerator(serverScripts, clientScripts, template, angularModules),
        sdrApi: makeSdrApi(serverScripts, angularModules)
    };
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
            if (typeof v === "object") {
                flattenObj(v);
            }
            maybeDone();
        }
    };

    var flattenObj = function (obj) {
        for (k in obj) {
            flattenKey(obj, k, obj[k]);
        }
    };

    flattenObj(obj);

    maybeDone();

    return defer.promise;
}

exports.middlewares = makeMiddlewares;
