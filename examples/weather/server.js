
var angularserver = require('../../lib/main.js');
var path = require('path');
var fs = require('fs');
var express = require('express');

var templateFile = path.join(__dirname, 'template.html');
var template = fs.readFileSync(templateFile, {encoding:'utf8'});
var staticDir = __dirname;

var app = express();
var angularMiddlewares = angularserver.Server(
    {
        template: template,
        serverScripts: [
            path.join(__dirname, 'angular.js'),
            path.join(__dirname, 'common.js')
        ],
        clientScripts: [
            '/:static/angular.js',
            '/:static/angular-route.js',
            '/:static/common.js',
            '/:static/clientonly.js'
        ],
        angularModules: [
            'simpleapp'
        ]
    }
);

app.use('/:static', express.static(staticDir));
app.use('/:', angularMiddlewares.sdrApi);
app.use(angularMiddlewares.htmlGenerator);

app.listen(3000);
console.log('Listening on port 3000');
