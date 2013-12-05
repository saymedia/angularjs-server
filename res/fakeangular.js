
// This is a fake angular-like thing that we can load into an angular context for tests.
var modulesRegistered = [];
var requestsRegistered = [];
window.angular = {
    fake: true,
    modulesRegistered: modulesRegistered,
    requestsRegistered: requestsRegistered,
    module: function (name, deps) {
        if (deps) {
            modulesRegistered.push(name);
        }
        // just enough module to keep ngoverrides happy
        return {
            factory: function (name) {
                return this;
            },
            provider: function (name) {
                return this;
            },
            directive: function (name) {
                return this;
            }
        };
    },
    injector: function (modules) {
        var fakeInjector = {};
        fakeInjector.get = function (name) {
            if (name === 'serverRequestContext') {
                return {
                    setRequest: function (request) {
                        requestsRegistered.push(request);
                    }
                };
            }
            else {
                return {
                    fake: true
                };
            }
        };
        return fakeInjector;
    },
    copy: function (thing) {
        // this is only here to make getInjector work in our server module, so it only supports shallow
        // copies of arrays since that's all we need for this situation.
        var ret = [];
        for (var i = 0; i < thing.length; i++) {
            ret.push(thing[i]);
        }
        return ret;
    },
    element: function () {
        // just enough element-ness to keep the tests happy
        return [];
    }
};
