/* eslint-disable camelcase */

'use strict';

const { OAuth2App } = require('homey-oauth2app');
const signalR = require('@microsoft/signalr');
const { HubConnectionState } = require('@microsoft/signalr');
const { collect } = require('collect.js');
const Client = require('./Client');
const { blank } = require('./Utils');

class App extends OAuth2App {

  static OAUTH2_CLIENT = Client;
  static SYNC_INTERVAL = 2; // Minutes

  /*
  | Application events
  */

  // Application initialized
  async onOAuth2Init() {
    // Register unload event listener
    this.homey.on('unload', () => this.onOAuth2Uninit());

    // Set default data
    this.setDefaults();

    // Register flow cards
    this.registerFlowCards();

    this.log('Initialized');
  }

  // Application destroyed
  async onOAuth2Uninit() {
    // Unregister timer
    this.unregisterTimer();

    // Unregister webhook
    await this.unregisterWebhook();

    // Clear data
    this.setDefaults();

    this.log('Destroyed');
  }

  /*
  | Synchronization functions
  */

  // Synchronize
  async sync(id = null) {
    if (this.syncing) return;
    this.syncing = true;

    let client;

    try {
      // Get client
      client = await this.getSavedOAuth2Client();

      this.log('[Sync] Started');

      // Unregister timer
      this.unregisterTimer();

      // Synchronize data
      if (blank(this.devices) || blank(id)) {
        await this.syncData(client);
      }

      // Synchronize device(s)
      this.homey.emit('sync');

      // Register webhook
      await this.registerWebhook(client);
    } catch (err) {
      if (err.message !== 'No OAuth2 Client Found') {
        this.error('[Sync]', err.message);

        return;
      }

      // Unregister webhook
      await this.unregisterWebhook();

      // Clear data
      this.setDefaults();
    } finally {
      // Register timer
      this.registerTimer();

      this.syncing = false;
      client = null;
    }
  }

  // Synchronize API data
  async syncData(client) {
    let devices = await client.getDevices();

    this.devices = collect(devices).keyBy('serialNumber').all();

    devices = null;
  }

  /*
  | Webhook functions
  */

  // Register webhook
  async registerWebhook(client) {
    if (this.webhook) return;
    this.webhook = 'register';

    try {
      const token = client.getToken().access_token;

      if (blank(token)) {
        this.webhook = null;
        return;
      }

      this.log('[Webhook] Registering');

      // Set connection
      this.webhook = new signalR.HubConnectionBuilder()
        .withUrl(`${Client.API_URL}/v1/changenotifications?token=${token}`)
        .configureLogging(signalR.LogLevel.Warning)
        .withAutomaticReconnect()
        .build();

      // Start connection
      await this.webhook.start();
      await this.webhook.invoke('Subscribe', ['2']);

      // Register event listeners
      await this.registerWebhookListeners();

      this.log('[Webhook] Registered');
    } catch (err) {
      // Refresh token when unauthorized
      if ('statusCode' in err && err.statusCode === 401) {
        this.log('[Webhook] Refresh oAuth token');

        client.refreshToken().catch(this.error);
      } else {
        this.error('[Webhook]', err.message);
      }

      this.webhook = null;
    } finally {
      client = null;
    }
  }

  // Register webhook listeners
  async registerWebhookListeners() {
    if (!this.webhook) return;

    this.log('[Webhook] Registering listeners');

    this.webhook.onreconnecting(this.onWebhookReconnecting.bind(this));
    this.webhook.onreconnected(this.onWebhookReconnected.bind(this));
    this.webhook.onclose(this.onWebhookClosed.bind(this));
    this.webhook.on('Notify', this.onWebhookMessage.bind(this));

    this.log('[Webhook] Listeners registered');
  }

  // Unregister webhook
  async unregisterWebhook() {
    if (!this.webhook) return;

    try {
      this.log('[Webhook] Unregistering');

      // Unsubscribe
      if (this.webhook.state === HubConnectionState.Connected) {
        await this.webhook.invoke('Unsubscribe', ['2']);
      }

      // Stop SignalR
      await this.webhook.stop();
    } catch (err) {
      this.error('[Webhook]', err.message);
    } finally {
      this.webhook = null;

      this.log('[Webhook] Unregistered');
    }
  }

  /*
  | Webhook events
  */

  // Webhook connection closed
  onWebhookClosed(err) {
    this.webhook = null;

    let msg = '[Webhook] Connection closed';
    if (err) msg += ` due to error "${err}"`;

    this.log(msg);
  }

  // Webhook message received
  async onWebhookMessage(body) {
    this.log('[Webhook] Received', JSON.stringify(body));

    // Synchronize
    await this.sync();
  }

  // Webhook reconnected
  onWebhookReconnected(connectionId) {
    this.log(`[Webhook] Connection reestablished with id '${connectionId}'`);
  }

  // Webhook reconnecting
  onWebhookReconnecting(err) {
    let msg = '[Webhook] Connection lost';
    if (err) msg += ` due to error "${err}"`;

    this.error(msg);
    this.log('[Webhook] Reconnecting');
  }

  /*
  | Timer functions
  */

  // Register timer
  registerTimer() {
    if (this.syncTimer) return;

    const interval = 1000 * 60 * this.constructor.SYNC_INTERVAL;

    this.syncTimer = this.homey.setInterval(this.sync.bind(this), interval);

    this.log('[Timer] Registered');
  }

  // Unregister timer
  unregisterTimer() {
    if (!this.syncTimer) return;

    this.homey.clearInterval(this.syncTimer);

    this.syncTimer = null;

    this.log('[Timer] Unregistered');
  }

  /*
  | Support functions
  */

  // Register flow cards
  registerFlowCards() {
    this.log('[FlowCards] Registering');

    // Trigger flow cards
    // When operating mode changed to ...
    this.homey.flow.getDeviceTriggerCard('operating_mode_changed').registerRunListener(async ({ device, operating_mode }) => {
      return device.getCapabilityValue('operating_mode') === operating_mode;
    });

    // Action flow cards
    // ... then set operating mode to ...
    // eslint-disable-next-line camelcase
    this.homey.flow.getActionCard('operating_mode_set').registerRunListener(async ({ device, operating_mode }) => {
      await device.onCapabilityOperatingMode(operating_mode);
    });

    // Condition flow cards
    // ... and connected is ...
    this.homey.flow.getConditionCard('connected').registerRunListener(async ({ device }) => {
      return device.getCapabilityValue('connected') === true;
    });

    // ... and heating is ...
    this.homey.flow.getConditionCard('is_heating').registerRunListener(async ({ device }) => {
      return device.getCapabilityValue('heating') === true;
    });

    // ... and operating mode is ...
    this.homey.flow.getConditionCard('operating_mode_is').registerRunListener(async (args) => {
      return args.device.getCapabilityValue('operating_mode') === args.operating_mode;
    });

    this.log('[FlowCards] Registered');
  }

  async getSavedOAuth2Client() {
    try {
      return this.getFirstSavedOAuth2Client();
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      return this.getFirstSavedOAuth2Client();
    }
  }

  // Set default data
  setDefaults() {
    this.syncing = null;
    this.devices = null;
  }

}

module.exports = App;
