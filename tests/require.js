'use strict';

// This is just a basic test that we can even import the module.
exports.testRequire = function (test) {
    var server = require('../lib/main.js');
    test.ok(server, 'angularjs-server is truthy');
    test.done();
};