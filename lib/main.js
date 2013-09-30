
var http = require('http');
var angularcontext = require('angularcontext');
var ngoverrides = require('./ngoverrides.js');

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

function makeRequestListener(template, scripts, modules) {
    return function (request, response) {
        var context = angularcontext.Context();
        context.runFiles(
            scripts,
            function (success, error) {
                if (error) {
                    sendError(error, response);
                    context.dispose();
                    return;
                }

                ngoverrides.registerModule(context);

                handleRequest(template, context, modules, request, response);
            }
        );
    };
}

function handleRequest(template, context, modules, request, response) {

    try {
        var modules = context.getAngular().copy(modules);
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
            // Stash any controller locals we pre-resolved so we can return them
            // to the client as a sort of cache so the browser can avoid additional round-trips.
            var preResolved = {};
            if (route.$$route && route.$$route.resolve) {
                for (var k in route.$$route.resolve) {
                    if (route.locals[k] !== undefined) {
                        preResolved[k] = route.locals[k];
                    }
                }
            }

            $httpBackend.notifyWhenNoOpenRequests(
                function () {
                    // once more for luck
                    $rootScope.$digest();

                    response.writeHead(200);
                    response.end(element[0].outerHTML);
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

function createServer(template, scripts, modules) {
    var listener = makeRequestListener(template, scripts, modules);
    return http.createServer(listener);
}

exports.makeRequestListener = makeRequestListener;
exports.createServer = createServer;


