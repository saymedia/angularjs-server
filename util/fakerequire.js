
// This is a brain-dead simple sorta-kinda-AMD-loader.
// Something like this is useful when your AngularJS app is also using RequireJS.
// It doesn't implement the full AMD spec but it implements enough that 'define' should work
// and then you can use loadAmdModule to synchronously execute a particular AMD module.

var amdModules = {};

function define(name, deps, impl) {

    if (impl === undefined) {
        impl = deps;
        deps = [];
    }

    amdModules[name] = [deps, impl];

}

function require() {

}
require.config = function () {};

function loadAmdModule(name) {

    var module = amdModules[name];

    if (module) {
        if (module[2] === undefined) {
            var deps = module[0];
            var impl = module[1];

            if (! impl) {
                throw new Error('AMD module ' + name + ' has no implementation');
            }

            var args = [];
            args.length = deps.length;
            for (var i = 0; i < deps.length; i++) {
                var depName = deps[i];

                if (depName.charAt(0) === '.') {
                    var baseParts = name.split('/');
                    baseParts = baseParts.slice(0, baseParts.length - 1);
                    var depParts = baseParts.concat(depName.split('/'));
                    for (var j = 0; j < depParts.length; j++) {
                        var part = name[j];
                        if (part === '.') {
                            name.splice(j, 1);
                            j -= 1;
                        }
                        else if (part === '..') {
                            if (j === 1 && (name[2] === '..' || name[0] === '..')) {
                                break;
                            }
                            else if (j > 0) {
                                name.splice(j - 1, 2);
                                j -= 2;
                            }
                        }
                    }
                    depName = depParts.join('/').replace('./', '');
                }

                try {
                    args[i] = loadAmdModule(depName);
                }
                catch (err) {
                    // ignore errors while loading dependencies
                }
            }
            module[2] = impl.apply(null, args);
        }
        return module[2];
    }
    else {
        throw new Error('No AMD module called ' + name);
    }

}
