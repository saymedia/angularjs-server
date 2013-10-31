
var angularserver = require('../lib/main.js');
var path = require('path');
var fs = require('fs');
var express = require('express');

var templateFile = path.join(__dirname, 'simpleapp.html');
var template = fs.readFileSync(templateFile, {encoding:'utf8'});
var staticDir = __dirname;

var app = express();

app.use('/static', express.static(staticDir));

app.use(
    angularserver.makeRequestListener(
        {
            template: template,
            serverScripts: [
                path.join(__dirname, 'angular.js'),
                path.join(__dirname, 'angular-route.js'),
                path.join(__dirname, 'simpleapp.js')
            ],
            clientScripts: [
                '/static/angular.js',
                '/static/angular-route.js',
                '/static/simpleapp.js',
                '/static/simpleapp-client.js'
            ],
            angularModules: [
                'simpleapp'
            ]
        }
    )
);

app.listen(9008);
