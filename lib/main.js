
var http = require('http');
var angularcontext = require('angularcontext');
var ngoverrides = require('./ngoverrides.js');

function sendError(error, response) {
    response.writeHead(
        500,
        {
            'Content-Type': 'text/plain'
        }
    );
    response.end(
        [
            error.message,
            'at ' + error.fileName + ' line ' + error.lineNumber,
            ''
        ].join('\n')
    );
}

function makeRequestListener(template, scripts, modules) {
    modules.push('angularjs-server');
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

                handleRequest(context, modules, request, response);
            }
        );
    };
}

function handleRequest(context, modules, request, response) {

    try {
        var injector = context.injector(modules);

        response.writeHead(200);
        response.end("got into handleRequest with " + injector);

        context.dispose();
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


