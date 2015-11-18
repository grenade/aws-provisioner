let debug = require('debug')('aws-provisioner:bin:provisioner');
let base = require('taskcluster-base');
let provision = require('../lib/provision');
let Aws = require('multi-region-promised-aws');
let workerType = require('../lib/worker-type');
let secret = require('../lib/secret');
let workerState = require('../lib/worker-state');
let AwsManager = require('../lib/aws-manager');
let taskcluster = require('taskcluster-client');
let _ = require('lodash');

let launch = function () {
  let cfg = require('typed-env-config')();

  let allowedRegions = cfg.app.allowedRegions.split(',');
  let keyPrefix = cfg.app.awsKeyPrefix;
  let pubKey = cfg.app.awsInstancePubkey;
  let provisionerId = cfg.app.id;
  let provisionerBaseUrl = cfg.server.publicUrl + '/v1';
  let maxInstanceLife = cfg.app.maxInstanceLife;

  let influx = new base.stats.Influx({
    connectionString: cfg.influx.connectionString,
    maxDelay: cfg.influx.maxDelay,
    maxPendingPoints: cfg.influx.maxPendingPoints,
  });

  let Secret = secret.setup({
    table: cfg.app.secretTableName,
    credentials: cfg.azure,
  });

  let WorkerType = workerType.setup({
    table: cfg.app.workerTypeTableName,
    credentials: cfg.azure,
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
    },
  });

  let WorkerState = workerState.setup({
    table: cfg.app.workerStateTableName,
    credentials: cfg.azure,
  });

  // Create all the things which need to be injected into the
  // provisioner
  let ec2 = new Aws('EC2', _.omit(cfg.aws, 'region'), allowedRegions);
  let awsManager = new AwsManager(
      ec2,
      provisionerId,
      keyPrefix,
      pubKey,
      maxInstanceLife,
      influx);
  let queue = new taskcluster.Queue({credentials: cfg.taskcluster.credentials});

  let config = {
    WorkerType: WorkerType,
    Secret: Secret,
    WorkerState: WorkerState,
    queue: queue,
    provisionerId: provisionerId,
    taskcluster: cfg.taskcluster,
    influx: influx,
    awsManager: awsManager,
    provisionIterationInterval: cfg.app.iterationInterval,
  };

  let provisioner = new provision.Provisioner(config);
  try {
    provisioner.run();
  } catch (err) {
    debug('[alert-operator] Error: %j %s', err, err.stack);
  }
};

// Only start up the server if we are running as a script
if (!module.parent) {
  // Find configuration profile
  launch();
  debug('launched provisioner successfully');
}

module.exports = launch;
