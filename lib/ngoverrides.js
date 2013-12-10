'use strict';

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

    // we depend on ngRoute here to be sure that, even if the application has provided the "real"
    // ngRoute module, we'll always register after it and get to override $route.
    var module = context.module('angularjs-server', ['ng', 'ngRoute']);
    var angular = context.getAngular();

    module.factory(
        'serverRequestContext',
        function ($injector) {
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
                                parts.pathname = set;
                                redirectTo = absUrl();
                                var $rootScope = $injector.get('$rootScope');
                                $rootScope.$broadcast(
                                    '$locationChangeSuccess',
                                    redirectTo,
                                    oldUrl
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
                hasRequest: function () {
                    return request ? true : false;
                },
                getRedirectTo: function () {
                    return redirectTo;
                }
            };
        }
    );

    module.provider(
        'serverFlattenPromises',
        {
            $get: function ($q) {
                return function (obj) {
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
                };
            }
        }
    );

    module.provider(
        '$log',
        function () {

            return {
                $get: function (serverRequestContext) {

                    function makeLogProxy(methodName) {
                        return function () {
                            var logArgs = [
                                serverRequestContext.hasRequest() ?
                                    '[' + serverRequestContext.location.absUrl() + ']' :
                                    '[location not set]'
                            ].concat(Array.prototype.slice.call(arguments, 0));

                            console[methodName].apply(
                                console,
                                logArgs
                            );
                        };
                    };

                    return {
                        debug: makeLogProxy('log'),
                        error: makeLogProxy('error'),
                        info: makeLogProxy('info'),
                        log: makeLogProxy('log'),
                        warn: makeLogProxy('warn')
                    };
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
                    return this;
                },
                hashPrefix: function (prefix) {
                    // again, not relevant on the server.
                    return this;
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
                    var nextRequestId = 0;
                    var pendingRequests = {};

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

                    // Register so we can know when our context is being disposed, so that we
                    // can abort any outstanding requests.
                    context.onDispose(
                        function () {
                            for (var requestId in pendingRequests) {
                                var req = pendingRequests[requestId];
                                req.abort();
                                delete pendingRequests[requestId];
                            }
                        }
                    );

                    var ret = function (
                        reqMethod, reqUrl, reqData, callback, headers,
                        timeout, withCredentials, responseType
                    ) {
                        startRequest();
                        if (reqMethod.toLowerCase() === 'jsonp') {
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

                            var thisRequestId = nextRequestId;
                            nextRequestId++;
                            var req = pendingRequests[thisRequestId] = module.request(
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
                                    // ignore responses to aborted requests
                                    if (! pendingRequests[thisRequestId]) {
                                        return;
                                    }

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
                                            // ignore responses to aborted requests
                                            if (! pendingRequests[thisRequestId]) {
                                                return;
                                            }
                                            resData.push(chunk);
                                        }
                                    );
                                    res.on(
                                        'end',
                                        function () {
                                            // ignore responses to aborted requests
                                            if (! pendingRequests[thisRequestId]) {
                                                return;
                                            }
                                            delete pendingRequests[thisRequestId];
                                            // Call the callback before endRequest, to give the
                                            // callback a chance to push more requests into the queue
                                            // before we check if we're done.
                                            callback(status, resData.join(''), headers);
                                            endRequest();
                                        }
                                    );
                                }
                            );
                            req.on(
                                'error',
                                function (err) {
                                    // ignore responses to aborted requests
                                    if (! pendingRequests[thisRequestId]) {
                                        return;
                                    }
                                    delete pendingRequests[thisRequestId];
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
                        // check for openReqs asynchronously to give any pending requests
                        // a chance to begin.
                        setTimeout(
                            function () {
                                if (openReqs > 0) {
                                    doneCallbacks.push(cb);
                                }
                                else {
                                    setTimeout(cb, 1);
                                }
                            },
                            1
                        );
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

            var baseRoute = {
                reloadOnSearch: true
            };

            this.when = function (path, route) {
                routes[path] = angular.extend(
                    {},
                    baseRoute,
                    route,
                    path && pathRegExp(path, route)
                );

                // create redirection for trailing slashes
                if (path) {
                    var redirectPath = (path[path.length - 1] === '/') ?
                        path.substr(0, path.length - 1) :
                        path + '/';

                    routes[redirectPath] = angular.extend(
                        {redirectTo: path},
                        baseRoute,
                        pathRegExp(redirectPath, route)
                    );
                }

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
                        function (_, slash, key, option) {
                            var optional = option === '?' ? option : null;
                            var star = option === '*' ? option : null;
                            keys.push({ name: key, optional: !!optional });
                            slash = slash || '';
                            return '' +
                                (optional ? '' : slash) +
                                '(?:' +
                                (optional ? slash : '') +
                                (star && '(.+)?' || '([^/]+)?') + ')' +
                                (optional || '');
                        })
                    .replace(/([\/$\*])/g, '\\$1');

                ret.regexp = new RegExp('^' + path + '$', insensitive ? 'i' : '');
                return ret;
            }

            function inherit(parent, extra) {
                var extendee = angular.extend(
                    function () {},
                    {
                        prototype: parent
                    }
                );
                return angular.extend(
                    new extendee(),
                    extra
                );
            }

            this.$get = function (
                $rootScope,
                $location,
                $routeParams,
                $q,
                $injector,
                $http,
                $templateCache
            ) {

                var routeMethods = {
                    jsonFriendly: function () {
                        var route = this;
                        var flattenPromises = $injector.get('serverFlattenPromises');
                        var defer = $q.defer();

                        route.populateLocals().then(
                            function (route) {
                                var locals = {};
                                var localServices = {};

                                if (route.resolve) {
                                    for (var k in route.resolve) {
                                        var resolver = route.resolve[k];
                                        if (typeof resolver === 'string') {
                                            // they want to inject a service, but we can't serialize a service
                                            // as JSON so we just return the service names so the recipient of
                                            // this object can resolve them itself.
                                            localServices[k] = resolver;
                                        }
                                        else {
                                            locals[k] = route.locals[k];
                                        }
                                    }
                                }

                                // although route.resolve already resolved the top-level promises,
                                // we might need to do some more work if there are any promises nested
                                // inside the already-resolved objects; we have to completely resolve the
                                // whole structure before we can return the data as JSON.
                                flattenPromises(locals).then(
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
                                    function (error) {
                                        defer.reject(error);
                                    }
                                );
                            }
                        );

                        return defer.promise;
                    },
                    populateLocals: function () {
                        var route = this;
                        var defer = $q.defer();
                        var $route = $injector.get('$route');

                        route.locals = route.locals || {};

                        // route resolve functions often depend on $route.current to get at
                        // route parameters. In order to make that work in this context, where there isn't
                        // really a "current route", we inject a special version of $route that has
                        // $route.current overridden.
                        // This should work for most apps, although an app that stashes this object somewhere
                        // for later use outside of the resolve function could run into problems.
                        var local$route = angular.extend(
                            {},
                            $route,
                            {
                                current: route
                            }
                        );

                        if (route.resolve) {
                            for (var k in route.resolve) {
                                var resolver = route.resolve[k];
                                if (typeof resolver === 'string') {
                                    route.locals[k] = injector.get(resolver);
                                }
                                else {
                                    route.locals[k] = injector.invoke(
                                        resolver,
                                        undefined,
                                        {
                                            '$route': local$route
                                        }
                                    );
                                }
                            }
                        }

                        if (route.template) {
                            route.locals.$template = route.template;
                        }
                        else if (route.templateUrl) {
                            // FIXME: if templateUrl, set it to a promise to fetch the given URL,
                            // which our $q.all below will then wait for.
                            throw new Error('route.templateUrl is not currently supported');
                        }

                        $q.all(route.locals).then(
                            function () {
                                defer.resolve(route);
                            },
                            function (error) {
                                defer.reject(error);
                            }
                        );

                        return defer.promise;
                    }
                };

                var $route = {};

                $route.routes = routes;

                function switchRouteMatcher(on, route) {
                    var keys = route.keys;
                    var params = {};

                    if (!route.regexp) {
                        return null;
                    }

                    var m = route.regexp.exec(on);
                    if (!m) {
                        return null;
                    }

                    for (var i = 1, len = m.length; i < len; ++i) {
                        var key = keys[i - 1];

                        var val = 'string' === typeof m[i] ?
                            decodeURIComponent(m[i]) :
                            m[i];

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
                                    angular.extend(
                                        match,
                                        routeMethods
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
                    var route = inherit(
                        routes[null],
                        {
                            params: {},
                            pathParams: {}
                        }
                    );
                    angular.extend(
                        route,
                        routeMethods
                    );
                    return route;
                };

                return $route;

            };
        }
    );

    module.provider(
        '$routeParams',
        function () {
            this.$get = function () { return {}; };
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
                compile: function (element, attr, linker) {
                    return function (scope, $element, attr) {
                        var currentScope,
                            currentElement,
                            onloadExp = attr.onload || '';

                        function cleanupLastView() {
                            if (currentScope) {
                                currentScope.$destroy();
                                currentScope = null;
                            }
                            if (currentElement) {
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
                                    function (clone) {
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
                                    }
                                );
                            } else {
                                cleanupLastView();
                            }
                        }

                        scope.$on('$routeChangeSuccess', update);
                        update();

                    };
                }
            };
        }
    );
}

exports.registerModule = registerModule;
