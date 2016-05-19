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

    // an app that depends on ngAnimate will fail on the absence of $rootElement in unbootstrapped
    // server context, and animation is not relevant on the server, so we just override it.
    context.module('ngAnimate', []);

    // we depend on ngRoute here to be sure that, even if the application has provided the "real"
    // ngRoute module, we'll always register after it and get to override $route.
    var module = context.module('angularjs-server', ['ng', 'ngRoute']);
    var angular = context.getAngular();

    // Timeout and interval don't really make sense in the server context, because we're always
    // trying to get stuff together as quickly as possible to return. Therefore we change the
    // meaning of setTimeout and setInterval to simply "execute once, asynchronously but as soon
    // as possible". This supports the case where timeouts are used to force code to run async,
    // but it doesn't support the case where a timeout is actually being used to implement a timeout
    // for a long-running operation, since of course then the operation will 'time out' immediately.
    (function () {
        var $injector = angular.injector(['ng']);
        var window = $injector.get('$window');
        var nextId = 1;
        // A map of pending ids to true if they are pending.
        // We intentionally avoid storing any references to the provided callback or to the
        // immediate object since this guarantees that only nodejs itself holds a reference to
        // the callback state and there's no risk of us leaking memory in here.
        var pending = {};

        var wrapCallback = function (id, cb) {
            return function () {
                if (pending[id]) {
                    delete pending[id];
                    cb.apply(this, arguments);
                }
            };
        };

        var enqueue = function (cb) {
            var id = nextId++;
            var wrappedCb = wrapCallback(id, cb);
            pending[id] = true;
            setImmediate(wrappedCb);
            return id;
        };

        var dequeue = function (id) {
            delete pending[id];
        };

        window.setTimeout = function (cb) {
            return enqueue(cb);
        };
        window.setInterval = function (cb) {
            return enqueue(cb);
        };
        window.clearTimeout = function (id) {
            dequeue(id);
        };
        window.clearInterval = function (id) {
            dequeue(id);
        };

        // Register so we can know when our context is being disposed, so that we
        // can abort any outstanding requests.
        context.onDispose(
            function () {
                pending = {};
            }
        );

        // don't need these guys after we're done setting up.
        $injector = undefined;
        window = undefined;
    })();

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
                return function (set, value) {
                    if (request) {
                        if (! requestUrlParts) {
                            requestUrlParts = url.parse(request.url, true);
                        }
                        return code(requestUrlParts, set, value);
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

            var reparseUrl = function () {
                requestUrlParts = url.parse(url.format(requestUrlParts), true);
            };

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
                                requestUrlParts.pathname = set;
                                reparseUrl();
                                return this;
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
                        function (parts, set, paramValue) {
                            if (set) {
                                if (paramValue === null) {
                                    delete parts.query[paramValue];
                                }
                                else if (paramValue) {
                                    parts.query[set] = paramValue;
                                }
                                else {
                                    parts.query = set;
                                }
                                var searchArgs = [];
                                for (var k in parts.query) {
                                    searchArgs.push(k + '=' + parts.query[k]);
                                }
                                requestUrlParts.search = '?' + searchArgs.join('&');
                                reparseUrl();
                                return this;
                            }
                            return parts.query;
                        }
                    ),
                    replace: function () {
                        return this;
                    },
                    runningOnServer: true,
                    url: parsedUrl(
                        function (parts, set) {
                            if (set) {
                                requestUrlParts = url.parse(set, true);
                                reparseUrl();
                            }
                            return requestUrlParts.path;
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
                    }

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
        '$exceptionHandler',
        function () {
            return {
                $get: function ($log) {
                    return function (exception, cause) {
                        var parts = [exception.stack];
                        if (cause) {
                            parts.push('\nCaused by: ');
                            parts.push(cause);
                        }
                        $log.error(parts.join(''));
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
                $get: function (serverRequestContext, $location) {
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
                        var isJSONP = false;
                        if (reqMethod.toLowerCase() === 'jsonp') {
                            // We don't want to run an arbitrary callback on the server, so instead
                            // we'll just strip off the callback invocation and the caller will get
                            // back whatever JSON is inside.
                            reqMethod = 'GET';
                            isJSONP = true;
                        }
                        startRequest();
                        if (! serverRequestContext.hasRequest()) {
                            // we can't do HTTP requests yet, because we don't know our own URL.
                            console.error('Denied HTTP request', reqUrl, 'because we have no base URL');
                            callback(-1, undefined, undefined);
                            endRequest();
                        }
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
                        // Pass through any headers that were set in the original request
                        headers = headers || {};
                        headers.Host = urlParts.host;
                        var req = pendingRequests[thisRequestId] = module.request(
                            {
                                hostname: urlParts.hostname,
                                port: urlParts.port,
                                path: urlParts.pathname +
                                    (urlParts.search ? urlParts.search : ''),
                                method: reqMethod,
                                headers: headers
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
                                        var resStr = resData.join('');
                                        if (isJSONP) {
                                            // Assume everything up to the opening paren is the callback name
                                            resStr = resStr.replace(/^[^(]+\(/, '')
                                                           .replace(/\)\s*;?\s*$/, '');
                                        }
                                        // Call the callback before endRequest, to give the
                                        // callback a chance to push more requests into the queue
                                        // before we check if we're done.
                                        callback(status, resStr, headers);
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

    // $$SanitizeUri is actually a private service in AngularJS, so ideally we wouldn't touch it nor
    // depend on it at all, but this is a very common caller of Angular's internal "urlResolve" function
    // that ends up being particularly slow on jsdom, and so we override this service so we can use
    // a more efficient implementation in the server. What we really want to do here is override the
    // urlResolve function, but that's a local variable inside the AngularJS module and so we can't
    // get at it to override it.
    module.provider(
        '$$sanitizeUri',
        function () {
            var aHrefSanitizationWhitelist = /^\s*(https?|ftp|mailto|tel|file):/;
            var imgSrcSanitizationWhitelist = /^\s*(https?|ftp|file):|data:image\//;

            var ret = {};

            ret.aHrefSanitizationWhitelist = function (regexp) {
                if (angular.isDefined(regexp)) {
                    aHrefSanitizationWhitelist = regexp;
                    return this;
                }
                return aHrefSanitizationWhitelist;
            };

            ret.imgSrcSanitizationWhitelist = function (regexp) {
                if (angular.isDefined(regexp)) {
                    imgSrcSanitizationWhitelist = regexp;
                    return this;
                }
                return imgSrcSanitizationWhitelist;
            };

            ret.$get = function (serverRequestContext) {
                return function sanitizeUri(uri, isImage) {
                    var regex = isImage ? imgSrcSanitizationWhitelist : aHrefSanitizationWhitelist;

                    // if we don't know our base URL yet then we can't sanitize, so
                    // just skip. This generally applies only to a context created outside of
                    // a request, e.g. for server configuration, so malicious links here are
                    // pretty harmless anyway since we're not a browser and there's no user
                    // around to click on them.
                    if (! serverRequestContext.hasRequest()) {
                        return uri;
                    }

                    var baseUrl = serverRequestContext.location.absUrl();

                    // mimic the behavior of UrlResolve
                    var normalizedVal;
                    if (uri === null) {
                        normalizedVal = url.resolve(baseUrl, '/null');
                    }
                    else {
                        normalizedVal = url.resolve(baseUrl, uri);
                    }

                    if (normalizedVal !== '' && !normalizedVal.match(regex)) {
                        return 'unsafe:' + normalizedVal;
                    }
                    else {
                        return uri;
                    }
                };
            };

            return ret;
        }
    );

    // The $sceDelegate service is another common caller of urlResolve, so we override this too.
    // For the moment we override it to be a no-op, but we might want to revisit this later to
    // ensure that we're sanitizing user-provided content on the server as well as the client.
    // For now we assume that there are fewer opportunities for injection on the server, since we
    // don't run inline scripts, we don't follow links, etc.
    module.provider(
        '$sceDelegate',
        function () {
            this.$get = function () {
                var ret = {};

                ret.trustAs = function (type, value) {
                    return value;
                };

                ret.valueOf = function (value) {
                    return value;
                };

                ret.getTrusted = function (type, value) {
                    return value;
                };

                return ret;
            };

            // these two are here just to satisfy the interface. We don't actually use them.
            this.resourceUrlWhitelist = function () {
                return ['self'];
            };
            this.resourceUrlBlacklist = function () {
                return [];
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

                                // $template shows up based on the presence of 'template' or 'templateUrl'
                                // in the route, not based on route.resolve like the others we'll handle
                                // below.
                                if (route.locals.$template) {
                                    locals.$template = route.locals.$template;
                                }

                                if (route.resolve) {
                                    // We walk resolve rather than route.locals directly so that we can
                                    // recognize which items were requests to inject a service and handle
                                    // those as a special case.
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
                        var $route = $injector.get('$route');

                        var locals = {};

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
                                    locals[k] = $injector.get(resolver);
                                }
                                else {
                                    locals[k] = $injector.invoke(
                                        resolver,
                                        undefined,
                                        {
                                            '$route': local$route
                                        }
                                    );
                                }
                            }
                        }

                        if (route.template !== undefined) {
                            locals.$template = route.template;
                        }
                        else if (route.templateUrl !== undefined) {
                            // For the moment we just fetch the template from our own server
                            // using an HTTP request, which ensures that the URL resolution will work
                            // how it would work in a browser. However, this is not especially efficient
                            // if the file happens to already be sitting on local disk, so we might
                            // want to do something better later. For now applications can circumvent
                            // this oddity by preloading the templates into the $templateCache.
                            var absTemplateUrl = url.resolve($location.absUrl(), route.templateUrl);
                            locals.$template = $http.get(
                                absTemplateUrl,
                                {
                                    cache: $templateCache
                                }
                            ).then(
                                function (response) {
                                    return response.data;
                                }
                            );
                        }

                        return $q.all(locals).then(
                            function (resolvedLocals) {
                                route.locals = resolvedLocals;
                                return route;
                            }
                        );
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

                            if (template !== undefined) {
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
