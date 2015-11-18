#!/usr/bin/env node
let path = require('path');
let debug = require('debug')('aws-app.bin:server');
let base = require('taskcluster-base');
let workerType = require('../lib/worker-type');
let secret = require('../lib/secret');
let workerState = require('../lib/worker-state');
let exchanges = require('../lib/exchanges');
let v1 = require('../lib/routes/v1');
let Aws = require('multi-region-promised-aws');
let _ = require('lodash');
let series = require('../lib/influx-series');

/** Launch server */
let launch = async function () {
  // Load configuration
  let cfg = require('typed-env-config')();

  let keyPrefix = cfg.app.awsKeyPrefix;
  let provisionerId = cfg.app.id;
  let provisionerBaseUrl = cfg.server.publicUrl + '/v1';

  // Create InfluxDB connection for submitting statistics
  let influx = new base.stats.Influx({
    connectionString: cfg.influx.connectionString,
    maxDelay: cfg.influx.maxDelay,
    maxPendingPoints: cfg.influx.maxPendingPoints,
  });

  // Configure me an EC2 API instance.  This one should be able
  // to run in any region, which we'll limit by the ones
  // store in the worker definition
  // NOTE: Should we use ec2.describeRegions? meh
  let ec2 = new Aws('EC2', _.omit(cfg.aws, 'region'), [
    'us-east-1', 'us-west-1', 'us-west-2',
    'eu-west-1', 'eu-central-1',
    'ap-southeast-1', 'ap-southeast-2', 'ap-northeast-1',
    'sa-east-1',
  ]);

  // Start monitoring the process
  base.stats.startProcessUsageReporting({
    drain: influx,
    component: cfg.app.statsComponent,
    process: 'server',
  });

  // Configure WorkerType entities
  let WorkerType = workerType.setup({
    table: cfg.app.workerTypeTableName,
    credentials: cfg.azure,
    context: {
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
    },
  });

  // Configure WorkerState entities
  let WorkerState = workerState.setup({
    table: cfg.app.workerStateTableName,
    credentials: cfg.azure,
  });

  // Configure WorkerType entities
  let Secret = secret.setup({
    table: cfg.app.secretTableName,
    credentials: cfg.azure,
  });

  // Get promise for workerType table created (we'll await it later)
  let tablesCreated = Promise.all([
    WorkerType.ensureTable(),
    WorkerState.ensureTable(),
    Secret.ensureTable(),
  ]);

  // Setup Pulse exchanges and create a publisher
  // First create a validator and then publisher
  let validator = await base.validator({
    folder: path.join(__dirname, '..', 'schemas'),
    constants: require('../schemas/constants'),
    publish: cfg.app.publishMetaData === 'true',
    schemaPrefix: 'aws-provisioner/v1/',
    aws: cfg.aws,
  });

  // Store the publisher to inject it as context into the API
  let publisher = await exchanges.setup({
    credentials: cfg.pulse,
    exchangePrefix: cfg.app.exchangePrefix,
    validator: validator,
    referencePrefix: 'aws-provisioner/v1/exchanges.json',
    publish: cfg.app.publishMetaData === 'true',
    aws: cfg.aws,
    drain: influx,
    component: cfg.app.statsComponent,
    process: 'server',
  });

  // We also want to make sure that the table is created.
  await tablesCreated;

  let reportInstanceStarted = series.instanceStarted.reporter(influx);

  // Create API router and publish reference if needed
  let router = await v1.setup({
    context: {
      WorkerType: WorkerType,
      WorkerState: WorkerState,
      Secret: Secret,
      ec2: ec2,
      publisher: publisher,
      keyPrefix: keyPrefix,
      provisionerId: provisionerId,
      provisionerBaseUrl: provisionerBaseUrl,
      reportInstanceStarted: reportInstanceStarted,
      credentials: cfg.taskcluster.credentials,
    },
    validator: validator,
    authBaseUrl: cfg.taskcluster.authBaseUrl,
    publish: cfg.app.publishMetaData === 'true',
    baseUrl: cfg.server.publicUrl + '/v1',
    referencePrefix: 'aws-provisioner/v1/api.json',
    aws: cfg.aws,
    component: cfg.app.statsComponent,
    drain: influx,
  });

  // Create app
  let app = base.app({
    port: cfg.server.port,
    env: cfg.server.env,
    forceSSL: cfg.server.forceSSL,
    trustProxy: cfg.server.trustProxy,
  });

  // Mount API router
  app.use('/v1', router);

  // Create server
  return app.createServer();
};

// If server.js is executed start the server
if (!module.parent) {
  launch().then(function () {
    debug('launched server successfully');
  }).catch(function (err) {
    debug('failed to start server, err: %s, as JSON: %j', err, err, err.stack);
    // If we didn't launch the server we should crash
    throw new Error('failed to start server');
  });
}

// Export launch in-case anybody cares
module.exports = launch;
