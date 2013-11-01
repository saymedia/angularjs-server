
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

function createServer(options) {
    var listener = makeRequestListener(options);
    return http.createServer(listener);
}

exports.makeRequestListener = makeRequestListener;
exports.createServer = createServer;


