'use strict';

const { OAuth2Driver } = require('homey-oauth2app');
const Data = require('./Data');

class Driver extends OAuth2Driver {

  /*
  | Driver events
  */

  // Driver initialized
  async onOAuth2Init() {
    this.log('Initialized');
  }

  // Driver destroyed
  async onOAuth2Uninit() {
    this.log('Destroyed');
  }

  /*
  | Pairing functions
  */

  // Pair devices
  async onPairListDevices({ oAuth2Client }) {
    this.log(`Pairing ${this.id}s`);

    // Fetch devices from API
    const results = await oAuth2Client.getDevices();

	// Convert results to device data
    const devices = results.map((device) => new Data(device).device).filter((e) => e);

    // Log found devices
    this.log('Found devices', JSON.stringify(devices));

    return devices;
  }

}

module.exports = Driver;
