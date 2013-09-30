
var url = require('url');
var http = require('http');
var https = require('https');

function registerModule(context) {
    var module = context.module('angularjs-server', ['ng']);

    module.factory(
        'serverRequestContext',
        function () {
            var request;
            var requestUrlParts;

            var ifRequest = function (code) {
                return function () {
                    if (request) {
                        return code();
                    }
                    else {
                        return undefined;
                    }
                };
            };
            var parsedUrl = function (code) {
                return function () {
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
            };

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

    module.provider(
        '$httpBackend',
        function () {
            return {
                $get: function ($location) {
                    var openReqs = 0;
                    var doneCallbacks = [];

                    var startRequest = function () {
                        openReqs++;
                    };
                    var endRequest = function () {
                        openReqs--;
                        if (openReqs < 1) {
                            openReqs = 0;
                            var toCall = doneCallbacks;
                            doneCallbacks = [];
                            for (var i = 0; i < toCall.length; i++) {
                                toCall[i]();
                            }
                        }
                    };

                    var ret = function (
                        reqMethod, reqUrl, reqData, callback, headers,
                        timeout, withCredentials, responseType
                    ) {
                        startRequest();
                        if (reqMethod.toLowerCase() == 'jsonp') {
                            // jsonp is not supported on the server, so fail quickly
                            // (but we still have to act asynchronous-like.)
                            setTimeout(
                                function () {
                                    callback(-2, undefined, undefined);
                                    endRequest();
                                },
                                1
                            );
                            return;
                        }
                        else {
                            reqUrl = url.resolve($location.absUrl(), reqUrl);
                            var urlParts = url.parse(reqUrl);

                            var module;
                            if (urlParts.protocol === 'http:') {
                                module = http;
                                if (! urlParts.port) {
                                    urlParts.port = 80;
                                }
                            }
                            else if (urlParts.protocol === 'https:') {
                                module = https;
                                if (! urlParts.port) {
                                    urlParts.port = 443;
                                }
                            }
                            else {
                                setTimeout(
                                    function () {
                                        // FIXME: Figure out what browsers do when an inappropriate
                                        // protocol is specified and mimic that here.
                                        callback(-1, undefined, undefined);
                                        endRequest();
                                    },
                                    1
                                );
                                return;
                            }

                            var req = module.request(
                                {
                                    hostname: urlParts.hostname,
                                    port: urlParts.port,
                                    path: urlParts.pathname +
                                        (urlParts.search ? urlParts.search : ''),
                                    method: reqMethod,
                                    headers: {
                                        'Host': urlParts.host
                                    }
                                },
                                function (res) {
                                    var status = res.statusCode;
                                    // Angular's interface expects headers as a string,
                                    // so we have to do a bit of an abstraction inversion here.
                                    var headers = '';
                                    for (var k in res.headers) {
                                        headers += k + ': ' + res.headers[k] + '\n';
                                    }
                                    res.setEncoding('utf8'); // FIXME: what if it's not utf8?
                                    var resData = [];
                                    res.on(
                                        'data',
                                        function (chunk) {
                                            resData.push(chunk);
                                        }
                                    );
                                    res.on(
                                        'end',
                                        function () {
                                            callback(status, resData.join(''), headers);
                                            endRequest();
                                        }
                                    );
                                }
                            );
                            req.on(
                                'error',
                                function (err) {
                                    // FIXME: What is a good error response code for this case?
                                    callback(-1, undefined, undefined);
                                    endRequest();
                                }
                            );
                            if (reqData) {
                                req.write(reqData);
                            }
                            req.end();
                        }
                    };

                    // Extra interface to allow our server code to detect when
                    // we're done loading things, so we know it's time to return
                    // the response.
                    ret.notifyWhenNoOpenRequests = function (cb) {
                        if (openReqs > 0) {
                            doneCallbacks.push(cb);
                        }
                        else {
                            cb();
                        }
                    };

                    return ret;
                }
            };
        }
    );

}

exports.registerModule = registerModule;
