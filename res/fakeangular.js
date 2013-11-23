
// This is a fake angular-like thing that we can load into an angular context for tests.
var modulesRegistered = [];
window.angular = {
    fake: true,
    modulesRegistered: modulesRegistered,
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
    }
};
