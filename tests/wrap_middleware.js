'use strict';

var path = require('path');

exports.testWrapMiddleware = function (test) {
    test.expect(9);
    var angularServer = require('../lib/main.js');

    var server = angularServer.Server(
        {
            serverScripts: [
                path.join(__dirname, '../res/fakeangular.js')
            ]
        }
    );

    test.ok(server, 'server is truthy');
    test.ok(server.wrapMiddlewareWithAngular, 'server.wrapMiddlewareWithAngular is truthy');

    var expectedReq = {};
    var expectedRes = {};
    var expectedNext = {};

    var mw = server.wrapMiddlewareWithAngular(
        function (gotReq, gotRes, gotNext, gotContext) {
            test.ok(gotReq === expectedReq, 'request passed through');
            test.ok(gotRes === expectedRes, 'response passed through');
            test.ok(gotNext === expectedNext, 'next passed through');
            test.ok(gotContext, 'context is truthy');

            var angular = gotContext.getAngular();

            test.ok(angular, 'angular is truthy');
            test.ok(angular.fake, 'angular is fake');
            test.ok(
                angular.modulesRegistered.indexOf('angularjs-server') !== -1,
                'angularjs-server module registered'
            );

            test.done();
        }
    );

    mw(expectedReq, expectedRes, expectedNext);

};
