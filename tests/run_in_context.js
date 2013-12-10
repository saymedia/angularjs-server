'use strict';

var path = require('path');

exports.testRunInContext = function (test) {
    test.expect(7);
    var angularServer = require('../lib/main.js');

    var server = angularServer.Server(
        {
            serverScripts: [
                path.join(__dirname, '../res/fakeangular.js')
            ],
            template: '<html></html>'
        }
    );

    test.ok(server, 'server is truthy');
    test.ok(server.runInContext, 'server.runInContext is truthy');

    server.runInContext(
        function ($injector, error) {
            test.ok(error === undefined, 'error is undefined');
            test.ok($injector, '$injector is truthy');

            var angular = $injector.angular;

            test.ok(angular, 'angular is truthy');
            test.ok(angular.fake, 'angular is fake');

            test.ok(
                angular.modulesRegistered.indexOf('angularjs-server') !== -1,
                'angularjs-server module registered'
            );

            test.done();
        }
    );

};
