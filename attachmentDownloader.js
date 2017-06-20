/**
 *
 * Script to download all attachments from instanceName that match a filter (attachmentFilter).
 * Attachments are stored on the filesystem in a directory based on the task number (INC000001).
 *
 * If there is no task number (the related record is not a task) the directory name is the sys_id of the related record)
 *
 * Duplicate filenames are handled.
 *
 */

var config = require('./config');
const instanceName = config.instanceName;
const userName = config.userName;
const password = config.password;
const attachmentFilter = config.attachmentFilter;
const logfile = config.logfile;

if (!instanceName || !userName || !password || !attachmentFilter || !logfile) {
    console.log('Bad configuration, exiting script');
    process.exit(1);
}

const request = require('request');
const waterfall = require('async-waterfall');
const async = require('async');
const path = require('path');
const fs = require('fs');
const http = require('http');
http.globalAgent.maxSockets = 5;

const instanceUrl = 'https://' + instanceName + '.service-now.com';
const logger = require('winston');
logger.configure({
    transports: [
        new (logger.transports.Console)(),
        new (logger.transports.File)({filename: logfile})
    ]
});

var percentTotal = 0;
var percentCompleted = 0;
var percentageComplete = 0;

function AttachmentHandler(att) {

    this.att = att;

    /*
     att = {
     "size_bytes": "205679",
     "file_name": "RMON2-MIB",
     "sys_mod_count": "1",
     "average_image_color": "",
     "image_width": "",
     "sys_updated_on": "2015-01-23 09:42:15",
     "sys_tags": "",
     "table_name": "ecc_agent_mib",
     "encryption_context": "",
     "sys_id": "00031755eb71310020ee20b6a206fe3d",
     "image_height": "",
     "sys_updated_by": "john.delinocci",
     "content_type": "application/octet-stream",
     "sys_created_on": "2015-01-23 09:42:13",
     "size_compressed": "30878",
     "compressed": "true",
     "table_sys_id": "83e2d355eb71310020ee20b6a206fef6",
     "sys_created_by": "john.delinocci"
     }
     */

    this.createDirectorySync = function (dir) {

        var dirName = path.join(__dirname, dir);

        if (!fs.existsSync(dirName)) {
            logger.info('Creating directory %s', dirName);
            fs.mkdirSync(dirName);
        }
    };

    this.cleanFileName = function (filename) {

        var newFn = filename.replace(/[|&;$%@"<>()+,*]/g, "");
        var newFn = newFn.replace(/[^\x00-\x7F]/g, "");

        return newFn;
    };

    this.getUniquePath = function (dirPath) {

        dirPath = this.cleanFileName(dirPath);

        // Ensure filename is unique
        if (!fs.existsSync(dirPath)) {
            return dirPath;
        }

        var uniqueFilename = false;
        var x = 1;

        while (!uniqueFilename) {
            var ext = path.extname(dirPath);
            var dirname = path.dirname(dirPath);
            var filename = path.basename(dirPath, ext);
            var newDirPath = dirname + path.sep + filename + '[' + x + ']' + ext;

            if (!fs.existsSync(newDirPath)) {
                logger.info('Duplicate filename, had to amend: %s', newDirPath);
                uniqueFilename = true;
                return newDirPath;
            }

            x++;
        }
    };

    this.writeAttachment = function (cb) {

        var that = this;

        waterfall([

            function (callback) {
                // create directory name for table
                that.createDirectorySync(that.att.table_name);

                // Get the task number for directory creation
                var options = {
                    url: instanceUrl + '/api/now/v2/table/' + that.att.table_name + '/' + that.att.table_sys_id,
                    auth: {
                        user: userName,
                        password: password
                    }
                };

                logger.info('Resolving task number for attachment: %s', that.att.sys_id);

                request(options, function (error, response, body) {

                    if (error) {
                        logger.error("ERROR!", error);
                        return callback(error);
                    }

                    if (!error && response.statusCode !== 200) {
                        console.log("ERROR!", error);
                        return callback(error);
                    }

                    body = JSON.parse(body);
                    var taskNumber = body.result.number ? body.result.number : body.result.sys_id;

                    callback(null, taskNumber);
                });
            },

            function (taskNumber, callback) {

                // Create directory for task number
                var dirPath = path.join(that.att.table_name, taskNumber);

                that.createDirectorySync(dirPath);
                callback(null, dirPath);
            },


            function (dirPath, callback) {

                // Download attachment
                var filename = that.getUniquePath(path.join(dirPath, that.att.file_name));
                var file = fs.createWriteStream(filename);
                var url = instanceUrl + '/api/now/v1/attachment/' + that.att.sys_id + '/file';
                logger.info('Downloading attachment: ' + filename + ' from url ' + url);


                var options = {
                    url: url,
                    auth: {
                        user: userName,
                        password: password
                    }
                };

                request(options)
                    .on('complete', function () {
                        percentCompleted++;
                        percentageComplete = parseInt(percentCompleted / percentTotal * 100);

                        logger.info('DOWNLOAD PROGRESS: %d%', percentageComplete);
                        callback(null);
                    })
                    .pipe(file, (function () {

                    }));

            },

        ], function (err) {
            cb();
        });


    }
}


// ***** Lets do it
waterfall([

    function (callback) {

        // Get a list of all attachments matching the filter and pass to next function
        logger.info('Starting download of attachments');
        logger.info('config: %j', config);
        const attachments = [];

        var options = {
            url: instanceUrl + '/api/now/v2/table/sys_attachment?sysparm_query=' + attachmentFilter,
            auth: {
                user: userName,
                password: password
            }
        };

        request(options, function (error, response, body) {

            logger.info('Querying sys_attachment table.');

            if (error) {
                logger.error('Error: %j', body);
                process.exit(1);
                return callback(error);
            }

            if (!error && response.statusCode !== 200) {
                logger.error('Error: statusCode: ', response.statusCode);
                process.exit(1);
                return callback(error);
            }

            body = JSON.parse(body);

            var counter = 1;
            percentTotal = body.result.length;
            logger.info('Iterating over %d attachments', percentTotal);

            body.result.forEach(function (att) {
                attachments.push(att);

                if (counter === body.result.length) {
                    callback(null, attachments);
                }

                counter++;
            });


        });
    },

    function (attachments, callback) {

        logger.info('Seen %d attachments from instance', attachments.length);

        async.eachOfLimit(attachments, 5, function (att, key, callback) {
            var a = new AttachmentHandler(att);
            a.writeAttachment(callback);
        });

    }

], function (err, result) {
});

