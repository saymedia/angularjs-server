
var url = require('url');
var http = require('http');
var https = require('https');

function registerModule(context) {
    // provide an empty ngRoute so that apps can depend on it even though we actually
    // provide what it provides natively.
    context.module('ngRoute', []);

    // we also provide an empty 'sdr' for the same reason, since the client-side app will probably
    // depend on it but it makes no sense to run server-defined routes *on* the server.
    context.module('sdr', []);

    var module = context.module('angularjs-server', ['ng']);
    var angular = context.getAngular();

    module.factory(
        'serverRequestContext',
        function ($rootScope) {
            var request;
            var requestUrlParts;
            var redirectTo;

            var ifRequest = function (code) {
                return function () {
                    if (request) {
                        return code();
                    }
                    else {
                        throw new Error('location not available yet');
                    }
                };
            };
            var parsedUrl = function (code) {
                return function (set) {
                    if (request) {
                        if (! requestUrlParts) {
                            requestUrlParts = url.parse(request.url, true);
                        }
                        return code(requestUrlParts, set);
                    }
                    else {
                        throw new Error('location not available yet');
                    }
                };
            };

            var absUrl = parsedUrl(
                function (parts) {
                    // TODO: Make this be https: when the
                    // request is SSL?
                    return 'http://' +
                        request.headers.host +
                        parts.pathname +
                        (parts.search ? parts.search : '');
                }
            );

            return {
                location: {
                    absUrl: absUrl,
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
                        function (parts, set) {
                            if (set) {
                                var oldUrl = absUrl();
                                $rootScope.$apply(
                                    function () {
                                        parts.pathname = set;
                                        redirectTo = absUrl();
                                        $rootScope.$broadcast(
                                            '$locationChangeSuccess',
                                            redirectTo,
                                            oldUrl
                                        );
                                    }
                                );
                            }
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
                    ),
                    runningOnServer: true
                },
                setRequest: function (newRequest) {
                    if (request) {
                        throw new Error('This context already has a request');
                    }
                    else {
                        request = newRequest;
                    }
                },
                getRedirectTo: function () {
                    return redirectTo;
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
                },
                html5Mode: function (mode) {
                    // not actually relevant on the server, but we support this call anyway
                    // so that client-oriented code can run unmodified on the server.
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
                            setTimeout(cb, 1);
                        }
                    };

                    return ret;
                }
            };
        }
    );

    // A reimplementation of $route that is largely the same as the standard $route but makes the
    // route introspection functions public.
    module.provider(
        '$route',
        function () {

            var routes = {};

            this.when = function (path, route) {
                routes[path] = angular.extend(
                    {reloadOnSearch: true},
                    route,
                    path && pathRegExp(path, route)
                );

                // create redirection for trailing slashes
                if (path) {
                    var redirectPath = (path[path.length-1] == '/')
                        ? path.substr(0, path.length-1)
                        : path +'/';

                    routes[redirectPath] = angular.extend(
                        {redirectTo: path},
                        pathRegExp(redirectPath, route)
                    );
                };

                return this;
            };

            this.otherwise = function (params) {
                this.when(null, params);
                return this;
            };

            function pathRegExp(path, opts) {
                var insensitive = opts.caseInsensitiveMatch,
                ret = {
                    originalPath: path,
                    regexp: path
                },
                keys = ret.keys = [];

                path = path
                    .replace(/([().])/g, '\\$1')
                    .replace(
                        /(\/)?:(\w+)([\?|\*])?/g,
                        function(_, slash, key, option){
                            var optional = option === '?' ? option : null;
                            var star = option === '*' ? option : null;
                            keys.push({ name: key, optional: !!optional });
                            slash = slash || '';
                            return ''
                                + (optional ? '' : slash)
                                + '(?:'
                                + (optional ? slash : '')
                                + (star && '(.+)?' || '([^/]+)?') + ')'
                                + (optional || '');
                        })
                    .replace(/([\/$\*])/g, '\\$1');

                ret.regexp = new RegExp('^' + path + '$', insensitive ? 'i' : '');
                return ret;
            }

            function inherit(parent, extra) {
                return angular.extend(new (angular.extend(function() {}, {prototype:parent}))(), extra);
            }

            this.$get = function (
                $rootScope,
                $location,
                $routeParams,
                $q,
                $injector,
                $http,
                $templateCache,
                $sce
            ) {

                var $route = {};

                $route.routes = routes;

                function switchRouteMatcher(on, route) {
                    var keys = route.keys;
                    var params = {};

                    if (!route.regexp) return null;

                    var m = route.regexp.exec(on);
                    if (!m) return null;

                    for (var i = 1, len = m.length; i < len; ++i) {
                        var key = keys[i - 1];

                        var val = 'string' == typeof m[i]
                            ? decodeURIComponent(m[i])
                            : m[i];

                        if (key && val) {
                            params[key.name] = val;
                        }
                    }
                    return params;
                }

                $route.getByPath = function (path, search) {
                    var match = null;
                    var params;
                    search = search || {};

                    angular.forEach(
                        routes,
                        function (route, routePath) {
                            if (! match) {
                                params = switchRouteMatcher(path, route);
                                if (params) {
                                    match = inherit(
                                        route,
                                        {
                                            params: angular.extend(
                                                {},
                                                search,
                                                params
                                            ),
                                            pathParams: params
                                        }
                                    );
                                    match.$$route = route;
                                }
                            }
                            else {
                                return;
                            }
                        }
                    );

                    return match;
                };

                $route.getOtherwise = function () {
                    return inherit(
                        routes[null],
                        {
                            params: {},
                            pathParams: {}
                        }
                    );
                };

                return $route;

            };
        }
    );

    module.provider(
        '$routeParams',
        function () {
            this.$get = function() { return {}; };
        }
    );

    // this does basically the same thing as the one in ngRoute, but we're forced to provide this
    // here because we can't load ngRoute without its $route implementation obscuring our overridden
    // version.
    module.directive(
        'ngView',
        function ($route, $anchorScroll, $compile, $controller, $animate) {
            return {
                restrict: 'ECA',
                terminal: true,
                priority: 1000,
                transclude: 'element',
                compile: function(element, attr, linker) {
                    return function(scope, $element, attr) {
                        var currentScope,
                            currentElement,
                            onloadExp = attr.onload || '';

                        scope.$on('$routeChangeSuccess', update);
                        update();

                        function cleanupLastView() {
                            if (currentScope) {
                                currentScope.$destroy();
                                currentScope = null;
                            }
                            if(currentElement) {
                                $animate.leave(currentElement);
                                currentElement = null;
                            }
                        }

                        function update() {
                            var locals = $route.current && $route.current.locals,
                                template = locals && locals.$template;

                            if (template) {
                                var newScope = scope.$new();
                                linker(
                                    newScope,
                                    function(clone) {
                                        cleanupLastView();

                                        clone.html(template);
                                        $animate.enter(clone, null, $element);

                                        var link = $compile(clone.contents()),
                                            current = $route.current;

                                        currentScope = current.scope = newScope;
                                        currentElement = clone;

                                        if (current.controller) {
                                            locals.$scope = currentScope;
                                            var controller = $controller(current.controller, locals);
                                            if (current.controllerAs) {
                                                currentScope[current.controllerAs] = controller;
                                            }
                                            clone.data('$ngControllerController', controller);
                                            clone.children().data('$ngControllerController', controller);
                                        }

                                        link(currentScope);
                                        currentScope.$emit('$viewContentLoaded');
                                        currentScope.$eval(onloadExp);

                                        // $anchorScroll might listen on event...
                                        $anchorScroll();
                                    });
                            } else {
                                cleanupLastView();
                            }
                        }
                    };
                }
            };
        }
    );
}

exports.registerModule = registerModule;
