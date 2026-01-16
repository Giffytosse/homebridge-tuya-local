const BaseAccessory = require('./BaseAccessory');

// define constants for Kogan garage door.
// Action
const GARAGE_DOOR_OPEN = 'open';
const GARAGE_DOOR_CLOSE = 'close';
const GARAGE_DOOR_FOPEN = 'fopen';
const GARAGE_DOOR_FCLOSE = 'fclose';

// Status or state
const GARAGE_DOOR_OPENED = 'opened';
const GARAGE_DOOR_CLOSED = 'closed';
const GARAGE_DOOR_OPENNING = 'openning';
const GARAGE_DOOR_OPENING = 'opening';
const GARAGE_DOOR_CLOSING = 'closing';

// Manufacturers
const GARAGE_DOOR_MANUFACTURER_KOGAN = 'Kogan';
const GARAGE_DOOR_MANUFACTURER_WOFEA = 'Wofea';

// CUSTOM: Define your Alarm DP
const DP_ALARM = '12';
const DP_TRAVEL_TIME = '4';

class GarageDoorAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.GARAGE_DOOR_OPENER;
    }

    constructor(...props) {
        super(...props);
        this.isMoving = false; // Track if the gate is currently in motion
        this.moveTimer = null;
        this.doorMoveTime = 20; // Default fallback
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;
        this.accessory.addService(Service.GarageDoorOpener, this.device.context.name);
        super._registerPlatformAccessory();
    }

    _logPrefix() {
        return (this.manufacturer ? this.manufacturer + ' ' : '') + 'GarageDoor';
    }

    _alwaysLog(...args) { this.log.info(this._logPrefix(), ...args); }

    _debugLog(...args) {
        this.log.debug(this._logPrefix(), ...args);
    }

    _isKogan() {
        return this.manufacturer === GARAGE_DOOR_MANUFACTURER_KOGAN.trim();
    }

    _isWofea() {
      return this.manufacturer === GARAGE_DOOR_MANUFACTURER_WOFEA.trim();
    }

    _registerCharacteristics(dps) {
        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.GarageDoorOpener);
        this._checkServiceName(service, this.device.context.name);

        // --- MANUFACTURER LOGIC ---
        if (this.device.context.manufacturer && this.device.context.manufacturer.trim().toLowerCase() === GARAGE_DOOR_MANUFACTURER_KOGAN.trim().toLowerCase()) {
            this.manufacturer = GARAGE_DOOR_MANUFACTURER_KOGAN.trim();
        } else if (this.device.context.manufacturer && this.device.context.manufacturer.trim().toLowerCase() === GARAGE_DOOR_MANUFACTURER_WOFEA.trim().toLowerCase()) {
            this.manufacturer = this.device.context.manufacturer.trim();
        } else if (this.device.context.manufacturer) {
            this.manufacturer = this.device.context.manufacturer.trim();
        } else {
            this.manufacturer = '';
        }

        // --- SET DPs ---
        if (this._isKogan()) {
            this.dpAction = this._getCustomDP(this.device.context.dpAction) || '101';
            this.dpStatus = this._getCustomDP(this.device.context.dpStatus) || '102';
        } else if (this._isWofea()) {
            this.dpAction = this._getCustomDP(this.device.context.dpAction) || '1';
            this.dpStatus = this._getCustomDP(this.device.context.dpStatus) || '101';
        } else {
            this.dpAction = this._getCustomDP(this.device.context.dpAction) || '1';
            this.dpStatus = this._getCustomDP(this.device.context.dpStatus) || '3';
        }

        // --- INITIAL TRAVEL TIME SYNC (DP 4) ---
        if (dps[DP_TRAVEL_TIME]) {
            this.doorMoveTime = parseInt(dps[DP_TRAVEL_TIME]) || 20;
            this._alwaysLog(`Initial Travel Time synced from Tuya: ${this.doorMoveTime}s`);
        }

        // --- DEFAULT STATES ---
        this.currentOpen = Characteristic.CurrentDoorState.OPEN;
        this.currentOpening = Characteristic.CurrentDoorState.OPENING;
        this.currentClosing = Characteristic.CurrentDoorState.CLOSING;
        this.currentClosed = Characteristic.CurrentDoorState.CLOSED;
        this.currentStopped = Characteristic.CurrentDoorState.STOPPED;
        this.targetOpen = Characteristic.TargetDoorState.OPEN;
        this.targetClosed = Characteristic.TargetDoorState.CLOSED;

        // --- REGISTER CHARACTERISTICS ---
        const characteristicTargetDoorState = service.getCharacteristic(Characteristic.TargetDoorState)
            .updateValue(this._getTargetDoorState(dps[this.dpStatus]))
            .on('get', this.getTargetDoorState.bind(this))
            .on('set', this.setTargetDoorState.bind(this));

        const characteristicCurrentDoorState = service.getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(this._getCurrentDoorState(dps[this.dpStatus]))
            .on('get', this.getCurrentDoorState.bind(this));

        const characteristicObstruction = service.getCharacteristic(Characteristic.ObstructionDetected)
            .updateValue(this._getObstructionState(dps[DP_ALARM]))
            .on('get', this.getObstructionState.bind(this));

        // --- CHANGE LISTENER ---
        this.device.on('change', changes => {
            this._alwaysLog('changed:' + JSON.stringify(changes));

            // 1. Handle Door Open/Close
            if (changes.hasOwnProperty(this.dpStatus)) {
                this.isMoving = false; // Reset movement flag when sensor is reached
                if (this.moveTimer) clearTimeout(this.moveTimer);

                const newCurrentDoorState = this._getCurrentDoorState(changes[this.dpStatus]);
                
                if (newCurrentDoorState == this.currentOpen && characteristicTargetDoorState.value !== this.targetOpen)
                    characteristicTargetDoorState.updateValue(this.targetOpen);

                if (newCurrentDoorState == this.currentClosed && characteristicTargetDoorState.value !== this.targetClosed)
                    characteristicTargetDoorState.updateValue(this.targetClosed);

                if (characteristicCurrentDoorState.value !== newCurrentDoorState) 
                    characteristicCurrentDoorState.updateValue(newCurrentDoorState);
            }

            // 2. Handle Obstruction (DP 12)
            if (changes.hasOwnProperty(DP_ALARM)) {
                const newObstructionState = this._getObstructionState(changes[DP_ALARM]);
                characteristicObstruction.updateValue(newObstructionState);
                
                // If mid-travel stop occurs, force HomeKit to recognize the stop
                if (newObstructionState && this.isMoving) {
                    this.isMoving = false;
                    characteristicCurrentDoorState.updateValue(this.currentOpen);
                    characteristicTargetDoorState.updateValue(this.targetOpen);
                }
            }

            // 3. Dynamic Travel Time Sync (DP 4)
            if (changes.hasOwnProperty(DP_TRAVEL_TIME)) {
                this.doorMoveTime = parseInt(changes[DP_TRAVEL_TIME]) || 20;
                this._alwaysLog(`Travel Time updated from Tuya App: ${this.doorMoveTime}s`);
            }
        });
    }

    // --- HELPER METHODS ---

    getObstructionState(callback) {
        this.getState(DP_ALARM, (err, dp) => {
            if (err) return callback(err);
            callback(null, this._getObstructionState(dp));
        });
    }

    _getObstructionState(dp) {
        const val = String(dp || 'none').toLowerCase();
        return (val !== 'none'); 
    }

    getTargetDoorState(callback) {
        this.getState(this.dpStatus, (err, dp) => {
            if (err) return callback(err);
            callback(null, this._getTargetDoorState(dp));
        });
    }

    _getTargetDoorState(dp) {
        if (dp === true) return this.targetOpen;
        return this.targetClosed;
    }

    setTargetDoorState(value, callback) {
        // --- STEP-BY-STEP LOGIC: STOP DURING MOTION ---
        if (this.isMoving) {
            this._alwaysLog('Mid-travel stop triggered. Sending pulse and snapping to OPEN.');
            
            this.setState(this.dpAction, true, (err) => {
                if (err) return callback(err);
                
                const service = this.accessory.getService(this.hap.Service.GarageDoorOpener);
                service.getCharacteristic(this.hap.Characteristic.CurrentDoorState)
                    .updateValue(this.hap.Characteristic.CurrentDoorState.OPEN);
                service.getCharacteristic(this.hap.Characteristic.TargetDoorState)
                    .updateValue(this.hap.Characteristic.TargetDoorState.OPEN);
                
                this.isMoving = false;
                if (this.moveTimer) clearTimeout(this.moveTimer);
                callback();
            });
            return;
        }

        // --- NORMAL MOVEMENT START ---
        this.isMoving = true;
        this.setState(this.dpAction, true, (err) => {
            if (err) {
                this.isMoving = false;
                return callback(err);
            }

            // Safety timeout based on synced DP 4 value (+5s buffer)
            const timeout = (this.doorMoveTime + 5) * 1000;
            this.moveTimer = setTimeout(() => {
                this.isMoving = false;
            }, timeout);

            callback();
        });
    }

    getCurrentDoorState(callback) {
        this.getState(this.dpStatus, (err, dpStatusValue) => {
            if (err) return callback(err);
            callback(null, this._getCurrentDoorState(dpStatusValue));
        });
    }

    _getCurrentDoorState(dpStatusValue) {
        if (dpStatusValue === true) return this.currentOpen;
        return this.currentClosed;
    }
}

module.exports = GarageDoorAccessory;
