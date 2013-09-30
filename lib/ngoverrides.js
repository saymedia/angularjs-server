
var url = require('url');

function registerModule(context) {
    var module = context.module('angularjs-server', ['ng']);

    module.provider(
        'serverRequestContext',
        function () {
            var request;
            var requestUrlParts;

            var ifRequest = function (code) {
                if (request) {
                    return code();
                }
                else {
                    return undefined;
                }
            };
            var parsedUrl = function (code) {
                if (request) {
                    if (! requestUrlParts) {
                        requestUrlParts = url.parse(request.url, true);
                    }
                    return code(requestUrlParts);
                }
                else {
                    return undefined;
                }
            };

            return {
                $get: function () {
                    return {
                        location: {
                            absUrl: ifRequest(
                                function () {
                                    // TODO: Make this be https: when the
                                    // request is SSL?
                                    return 'http://' +
                                        request.headers.host +
                                        request.url;
                                }
                            ),
                            hash: function () {
                                // the server never sees the fragment
                                return '';
                            },
                            host: ifRequest(
                                function () {
                                    return request.headers.host;
                                }
                            ),
                            path: parsedUrl(
                                function (parts) {
                                    return parts.pathname;
                                }
                            ),
                            port: ifRequest(
                                function () {
                                    // TODO: Make this actually check the port.
                                    return 80;
                                }
                            ),
                            protocol: ifRequest(
                                function () {
                                    // TODO: Make this be 'https' when the
                                    // request is SSL?
                                    return 'http';
                                }
                            ),
                            search: parsedUrl(
                                function (parts) {
                                    return parts.query;
                                }
                            )
                        }
                    };
                },
                setRequest: function (newRequest) {
                    if (request) {
                        throw new Error('This context already has a request');
                    }
                    else {
                        request = newRequest;
                    }
                }
            };
        }
    );

    module.provider(
        '$location',
        function () {
            return {
                $get: function (serverRequestContext) {
                    return serverRequestContext.location;
                }
            };
        }
    );

}

exports.registerModule = registerModule;
