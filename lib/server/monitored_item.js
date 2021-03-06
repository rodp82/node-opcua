"use strict";
/**
 * @module opcua.server
 *
 */
require("requirish")._(module);

var assert = require("better-assert");
var _ = require("underscore");

var EventEmitter = require("events").EventEmitter;
var util = require("util");

var subscription_service = require("lib/services/subscription_service");
var read_service = require("lib/services/read_service");

var DataValue = require("lib/datamodel/datavalue").DataValue;
var Variant = require("lib/datamodel/variant").Variant;
var StatusCodes = require("lib/datamodel/opcua_status_code").StatusCodes;
var NumericRange = require("lib/datamodel/numeric_range").NumericRange;
var AttributeIds = require("lib/datamodel/attributeIds").AttributeIds;
var BaseNode = require("lib/address_space/base_node").BaseNode;

var sameDataValue =  require("lib/datamodel/datavalue").sameDataValue;

var MonitoringMode = subscription_service.MonitoringMode;
var MonitoringParameters = subscription_service.MonitoringParameters;
var MonitoredItemModifyResult = subscription_service.MonitoredItemModifyResult;
var TimestampsToReturn = read_service.TimestampsToReturn;

var apply_timestamps = require("lib/datamodel/datavalue").apply_timestamps;


var defaultItemToMonitor = {indexRange: null, attributeId: read_service.AttributeIds.Value};


var minimumSamplingInterval = 50;              // 50 ms as a minimum sampling interval
var defaultSamplingInterval = 1500;            // 1500 ms as a default sampling interval
var maximumSamplingInterval = 1000 * 60 * 60;  // 1 hour !


function _adjust_sampling_interval(samplingInterval) {

    if(samplingInterval===0){
        return samplingInterval;
    }
    assert(samplingInterval>=0," this case should have been prevented outsides");
    samplingInterval = samplingInterval || defaultSamplingInterval;
    maximumSamplingInterval = maximumSamplingInterval || defaultSamplingInterval;
    samplingInterval = Math.max(samplingInterval, minimumSamplingInterval);
    samplingInterval = Math.min(samplingInterval, maximumSamplingInterval);
    return samplingInterval;
}


var maxQueueSize = 5000;

function _adjust_queue_size(queueSize) {
    queueSize = Math.min(queueSize, maxQueueSize);
    queueSize = Math.max(1, queueSize);
    return queueSize;
}


/**
 * a server side monitored item
 *
 * - Once created, the MonitoredItem will raised an "samplingEvent" event every "samplingInterval" millisecond
 *   until {{#crossLink "MonitoredItem/terminate:method"}}{{/crossLink}} is called.
 *
 * - It is up to the  event receiver to call {{#crossLink "MonitoredItem/recordValue:method"}}{{/crossLink}}.
 *
 * @class MonitoredItem
 * @param options  the options
 * @param options.clientHandle     {Number}  - the client handle
 * @param options.samplingInterval {Number}  - the sampling Interval
 * @param options.filter           {ExtensionObject}
 * @param options.discardOldest    {boolean} - if discardOldest === true, older items are removed from the queue
 *                                             when
 * @param options.queueSize        {Number} - the size of the queue.
 * @param options.monitoredItemId  {Number} the monitoredItem Id assigned by the server to this monitoredItem.
 * @param options.itemToMonitor
 * @param options.monitoringMode
 * @param options.timestampsToReturn
 * @constructor
 */
function MonitoredItem(options) {

    assert(options.hasOwnProperty("monitoredItemId"));
    assert(!options.monitoringMode, "use setMonitoring mode explicitly to activate the monitored item");

    EventEmitter.apply(this, arguments);
    options.itemToMonitor = options.itemToMonitor || defaultItemToMonitor;

    var self = this;
    self._samplingId = null;

    self._set_parameters(options);

    self.monitoredItemId = options.monitoredItemId; //( known as serverHandle)

    self.queue = [];
    self.overflow = false;


    self.oldDataValue = new DataValue({statusCode: StatusCodes.BadDataUnavailable}); // unset initially

    // user has to call setMonitoringMode
    self.monitoringMode = MonitoringMode.Invalid;

    self.timestampsToReturn = options.timestampsToReturn || TimestampsToReturn.Neither;

    self.itemToMonitor = options.itemToMonitor;

    self.filter = options.filter || null;

    /**
     * @property node the associated node object in the address space
     * @type {BaseNode|null}
     */
    self.node = null;
}
util.inherits(MonitoredItem, EventEmitter);


var ObjectRegisty = require("lib/misc/objectRegistry").ObjectRegisty;
var g_running_MonitoredItem = new ObjectRegisty();
MonitoredItem.getRunningMonitoredItemCount = g_running_MonitoredItem.count.bind(g_running_MonitoredItem);


MonitoredItem.minimumSamplingInterval = minimumSamplingInterval;
MonitoredItem.defaultSamplingInterval = defaultSamplingInterval;
MonitoredItem.maximumSamplingInterval = maximumSamplingInterval;

function _validate_parameters(options) {
    //xx assert(options instanceof MonitoringParameters);
    assert(options.hasOwnProperty("clientHandle"));
    assert(options.hasOwnProperty("samplingInterval"));
    assert(_.isFinite(options.clientHandle));
    assert(_.isFinite(options.samplingInterval));
    assert(_.isBoolean(options.discardOldest));
    assert(_.isFinite(options.queueSize));
    assert(options.queueSize >= 0);
}

MonitoredItem.prototype._stop_sampling = function () {

    var self = this;

    if (self._attribute_changed_callback) {

        g_running_MonitoredItem.unregister(self);

        var event_name = BaseNode.makeAttributeEventName(self.itemToMonitor.attributeId);
        self.node.removeListener(event_name,self._attribute_changed_callback);
        self._attribute_changed_callback = null;

    } else if (self._value_changed_callback) {

        g_running_MonitoredItem.unregister(self);

        // samplingInterval was 0 for a exception-based data Item
        // we setup a event listener that we need to unwind here
        assert(_.isFunction(self._value_changed_callback));
        assert(!self._samplingId);

        self.node.removeListener("value_changed",self._value_changed_callback);
        self._value_changed_callback = null;

    } else if (self._samplingId) {

        g_running_MonitoredItem.unregister(self);
        clearInterval(self._samplingId);
        self._samplingId = 0;
    }
    assert(!self._samplingId);
    assert(!self._value_changed_callback);
    assert(!self._attribute_changed_callback);
};

MonitoredItem.prototype._on_value_changed = function(dataValue,indexRange) {
    var self = this;
    if (!sameDataValue(dataValue,self.oldDataValue)) {
        self.recordValue(dataValue, indexRange);
    }
};

MonitoredItem.prototype._start_sampling = function (recordInitialValue) {

    var self = this;

    // make sure oldDataValue is scrapped so first data recording can happen
    self.oldDataValue = new DataValue({statusCode: StatusCodes.BadDataUnavailable}); // unset initially

    self._stop_sampling();

    g_running_MonitoredItem.register(self);


    if (self.itemToMonitor.attributeId !== AttributeIds.Value) {

        // sampling interval only applies to Value Attributes.
        self.samplingInterval = 0; // turned to exception-based regardless of requested sampling interval

        // non value attribute only react on value change
        self._attribute_changed_callback = self._on_value_changed.bind(this);
        var event_name = BaseNode.makeAttributeEventName(self.itemToMonitor.attributeId);

        self.node.on(event_name, self._attribute_changed_callback);

        if (recordInitialValue) {
            // read initial value
            var dataValue = self.node.readAttribute(self.itemToMonitor.attributeId);
            self.recordValue(dataValue);

        }
        return;
    }

    if (self.samplingInterval === 0) {
        // we have a exception-based dataItem : event based model, so we do not need a timer
        // rather , we setup the "value_changed_event";
        self._value_changed_callback = self._on_value_changed.bind(this);
        self.node.on("value_changed",self._value_changed_callback);

        // initiate first read
        if (recordInitialValue) {
            self.node.readValueAsync(function (err, dataValue) {
                self.recordValue(dataValue);
            });
        }
    } else {

        assert(self.samplingInterval >= minimumSamplingInterval);

        // settle periodic sampling
        self._samplingId = setInterval(function () {
            self._on_sampling_timer();
        }, self.samplingInterval);

        if (recordInitialValue) {
            // initiate first read (this requires self._samplingId to be set)
            self._on_sampling_timer();
        }
    }

};

MonitoredItem.prototype.setMonitoringMode = function (monitoringMode) {

    var self = this;

    assert(monitoringMode !== MonitoringMode.Invalid);

    if (monitoringMode === self.monitoringMode) {
        // nothing to do
        return;
    }

    var old_monitoringMode = self.monitoringMode;


    self.monitoringMode = monitoringMode;

    if (self.monitoringMode === MonitoringMode.Disabled ) {

        self._stop_sampling();

        // OPCUA 1.03 part 4 : $5.12.4
        // setting the mode to DISABLED causes all queued Notifications to be deleted
        self.queue   = [];
        self.overflow= false;
    } else {
        assert(self.monitoringMode === MonitoringMode.Sampling || self.monitoringMode === MonitoringMode.Reporting);

        // OPCUA 1.03 part 4 : $5.12.1.3
        // When a MonitoredItem is enabled (i.e. when the MonitoringMode is changed from DISABLED to
        // SAMPLING or REPORTING) or it is created in the enabled state, the Server shall report the first
        // sample as soon as possible and the time of this sample becomes the starting point for the next
        // sampling interval.
        var recordInitialValue = ( old_monitoringMode === MonitoringMode.Invalid || old_monitoringMode === MonitoringMode.Disabled);

        self._start_sampling(recordInitialValue);

    }
};

MonitoredItem.prototype._set_parameters = function (options) {
    var self = this;
    _validate_parameters(options);
    self.clientHandle = options.clientHandle;

    // The Server may support data that is collected based on a sampling model or generated based on an
    // exception-based model. The fastest supported sampling interval may be equal to 0, which indicates
    // that the data item is exception-based rather than being sampled at some period. An exception-based
    // model means that the underlying system does not require sampling and reports data changes.
    self.samplingInterval = _adjust_sampling_interval(options.samplingInterval);
    self.discardOldest = options.discardOldest;
    self.queueSize = _adjust_queue_size(options.queueSize);
};

/**
 * Terminate the  MonitoredItem.
 * @method terminate
 *
 * This will stop the internal sampling timer.
 */
MonitoredItem.prototype.terminate = function () {
    var self = this;
    self._stop_sampling();
};

/**
 * @method _on_sampling_timer
 * @private
 * request
 *
 */
MonitoredItem.prototype._on_sampling_timer = function () {

    var self = this;

    assert(self.monitoringMode === MonitoringMode.Sampling || self.monitoringMode == MonitoringMode.Reporting);

    if (self._samplingId) {
        //xx console.log("xxxx ON SAMPLING");
        assert(!self._is_sampling, "sampling func shall not be re-entrant !! fix it");

        assert(_.isFunction(self.samplingFunc));

        self._is_sampling = true;

        self.samplingFunc.call(self,self.oldDataValue,function(err,newDataValue) {
            //xx console.log("xxxx Sampling done",err);
            if (err){
                console.log(" SAMPLING ERROR =>",err);
            } else {
                self._on_value_changed(newDataValue);
            }
            self._is_sampling = false;
        });

    } else {
        /* istanbul ignore next */
        console.log("_on_sampling_timer call but MonitoredItem has been terminated !!! ");
    }
};

var extractRange = require("lib/datamodel/datavalue").extractRange;

var DataChangeFilter = subscription_service.DataChangeFilter;
var DataChangeTrigger = subscription_service.DataChangeTrigger;
var DeadbandType = subscription_service.DeadbandType;

function statusCodeHasChanged(newDataValue, oldDataValue) {
    assert(newDataValue instanceof DataValue);
    assert(oldDataValue instanceof DataValue);
    return newDataValue.statusCode !== oldDataValue.statusCode;
}

var DataType = require("lib/datamodel/variant").DataType;
function difference(v1,v2) {

    if (v1.dataType === DataType.UInt64 || v2.dataType === DataType.Int64) {
        var h1 = v1.value[0];
        var h2 = v2.value[0]
        assert(h1===h2,"TODO : fix this case");
        return v1.value[1] - v2.value[1];
    }
    return v2.value -v1.value;
}

function valueHasChanged(self,newDataValue, oldDataValue, deadbandType, deadbandValue) {


    assert(newDataValue instanceof DataValue);
    assert(oldDataValue instanceof DataValue);
    switch (deadbandType) {
        case DeadbandType.None:
            assert(newDataValue.value instanceof Variant);
            assert(newDataValue.value instanceof Variant);
            // No Deadband calculation should be applied.
            return difference(oldDataValue.value ,newDataValue.value) !== 0;
        case DeadbandType.Absolute:
            // AbsoluteDeadband
            var delta = Math.abs(difference(oldDataValue.value,newDataValue.value));
            return delta > deadbandValue;
        default:
            // Percent_2    PercentDeadband (This type is specified in Part 8).
            assert(deadbandType === DeadbandType.Percent);

            // The range of the deadbandValue is from 0.0 to 100.0 Percent.
            assert(deadbandValue >= 0 && deadbandValue <= 100);

            // DeadbandType = PercentDeadband
            // For this type of deadband the deadbandValue is defined as the percentage of the EURange. That is,
            // it applies only to AnalogItems with an EURange Property that defines the typical value range for the
            // item. This range shall be multiplied with the deadbandValue and then compared to the actual value change
            // to determine the need for a data change notification. The following pseudo code shows how the deadband
            // is calculated:
            //      DataChange if (absolute value of (last cached value - current value) >
            //                                          (deadbandValue/100.0) * ((high-low) of EURange)))
            //
            // Specifying a deadbandValue outside of this range will be rejected and reported with the
            // StatusCode Bad_DeadbandFilterInvalid (see Table 27).
            // If the Value of the MonitoredItem is an array, then the deadband calculation logic shall be applied to
            // each element of the array. If an element that requires a DataChange is found, then no further
            // deadband checking is necessary and the entire array shall be returned.
            assert(self.node !== null, "expecting a valid address_space object here to get access the the EURange");

            //assert(false, "Not implemented yet");
            return true;
    }
}
function apply_datachange_filter(self, newDataValue, oldDataValue) {

    assert(self.filter);
    assert(self.filter instanceof DataChangeFilter);
    assert(newDataValue instanceof DataValue);
    assert(oldDataValue instanceof DataValue);

    var trigger = self.filter.trigger;

    switch (trigger.value) {
        case DataChangeTrigger.Status.value:
            //              Report a notification ONLY if the StatusCode associated with
            //              the value changes. See Table 166 for StatusCodes defined in
            //              this standard. Part 8 specifies additional StatusCodes that are
            //              valid in particular for device data.
            return statusCodeHasChanged(newDataValue, oldDataValue);

        case DataChangeTrigger.StatusValue.value:
            //              Report a notification if either the StatusCode or the value
            //              change. The Deadband filter can be used in addition for
            //              filtering value changes.
            //              This is the default setting if no filter is set.
            return statusCodeHasChanged(newDataValue, oldDataValue) ||
	            valueHasChanged(self,newDataValue, oldDataValue, self.filter.deadbandType, self.filter.deadbandValue);

        default:
	    //              Report a notification if either StatusCode, value or the
	    //              SourceTimestamp change. If a Deadband filter is specified,
	    //              this trigger has the same behaviour as STATUS_VALUE_1.
	    //              If the DataChangeFilter is not applied to the monitored item, STATUS_VALUE_1
	    //              is the default reporting behaviour
	    assert(trigger === DataChangeTrigger.StatusValueTimestamp);
     }
     return false;
}

function apply_filter(self, newDataValue) {

    if (!self.oldDataValue) {
        return true;
    }
    var oldDataValue = self.oldDataValue;

    if (!self.filter) {
        return statusCodeHasChanged(newDataValue, oldDataValue) ||
            valueHasChanged(newDataValue, oldDataValue, DeadbandType.None);
    }
    assert(self.filter);
    if (self.filter instanceof DataChangeFilter) {
        return apply_datachange_filter(self, newDataValue, oldDataValue);
    }
    return true; // keep
}


/**
 * @property isSampling
 * @type boolean
 */
MonitoredItem.prototype.__defineGetter__("isSampling",function() {
    var self = this;
    return !!self._samplingId || _.isFunction(self._value_changed_callback) ||
           _.isFunction(self._attribute_changed_callback);
});

/**
 * @method recordValue
 * @param dataValue {DataValue}     the whole datavalue
 * @param indexRange {NumericRange} the region that has changed in the dataValue
 *
 * Note: recordValue can only be called within timer event
 */
MonitoredItem.prototype.recordValue = function (dataValue, indexRange) {

    var self = this;
    assert(dataValue instanceof DataValue);

    //xx console.log("MonitoredItem.prototype.recordValue = function (dataValue,indexRange) { ");
    //xx console.log(new DataValue(dataValue).toString(),"\n indexRange = ".cyan,indexRange);

    if (!NumericRange.overlap(indexRange, self.itemToMonitor.indexRange)) {
        //xx console.log(" NO OVERLAP".red);
        return; // nothing to record
    }

    dataValue = extractRange(dataValue, self.itemToMonitor.indexRange);

    //xx console.log("Modified ",new DataValue(dataValue).toString(),"\n indexRange = ",self.itemToMonitor.indexRange);
    //xxx console.log("xxx recordValue!",self.monitoredItemId.toString(),dataValue.value.toString());

    dataValue = dataValue instanceof DataValue ? dataValue : new DataValue(dataValue);
    // store last value

    if (self.filter) {
        if (!apply_filter(self, dataValue)) {
            //xx console.log(" Apply filter",self.filter.toString());
            return;
        }
    }

    self._enqueue_value(dataValue);

    self.oldDataValue = dataValue;
};

MonitoredItem.prototype._enqueue_value = function(dataValue)
{
    var self = this;

    self.oldDataValue = dataValue;

    if (self.queueSize === 1) {
        // ensure queuesize
        if (!self.queue || self.queue.length !== 1) {
            self.queue = [null];
        }
        self.queue[0] = dataValue;
        assert(self.queue.length === 1);

    } else {
        if (self.discardOldest) {

            // push new value to queue
            self.queue.push(dataValue);

            if (self.queue.length > self.queueSize) {
                self.overflow = true;
                //xx console.log("xxxxx ",dataValue.statusCode.toString());
                self.queue.shift(); // remove front element

                // set overflow bit
                assert( self.queue[0].statusCode === StatusCodes.Good);
                self.queue[0].statusCode = StatusCodes.GoodWithOverflowBit;
            }

        } else {
            if (self.queue.length < self.queueSize) {
                self.queue.push(dataValue);
            } else {
                self.overflow = true;
                dataValue.statusCode = StatusCodes.GoodWithOverflowBit;
                //xx console.log("xxxxx ",dataValue.statusCode.toString());
                self.queue[self.queue.length - 1] = dataValue;
            }
        }
    }
};

MonitoredItem.prototype._empty_queue = function()
{
    var self = this;

    // empty queue
    self.queue = [];
    self.overflow = false;

};

/**
 * @method  extractMonitoredItemNotifications
 * @return {Array.<*>}
 */
MonitoredItem.prototype.extractMonitoredItemNotifications = function () {

    var self = this;

    if (self.monitoringMode !== MonitoringMode.Reporting) {
        return [];
    }

    var attributeId = self.itemToMonitor.attributeId;

    // MonitoredItemNotification
    var notifications = self.queue.map(function (dataValue) {

        dataValue = apply_timestamps(dataValue, self.timestampsToReturn, attributeId);
        return {clientHandle: self.clientHandle, value: dataValue};
    });

    self._empty_queue();

    return notifications;
};

MonitoredItem.prototype._change_timer_timeout = function () {
    var self = this;
    if (!self._samplingId) { return; }

    clearInterval(self._samplingId);

    self._samplingId = setInterval(function () {
        self._on_sampling_timer();
    }, self.samplingInterval);

};


MonitoredItem.prototype._adjust_queue_to_match_new_queue_size = function (old_queueSize) {

    var self = this;
    // adjust queue size if necessary
    if (self.queueSize < self.queue.length) {

        if (self.discardOldest) {

            self.queue.splice(0, self.queue.length - self.queueSize);

        } else {

            var lastElement = self.queue[self.queue.length-1];
            // only keep queueSize first element, discard others
            self.queue.splice(self.queueSize);
            self.queue[self.queue.length-1] = lastElement;
        }
    }
    if (self.queueSize <= 1) {
        self.overflow = false;
        // unset OverFlowBit
        if (self.queue.length === 1) {
            if (self.queue[0].statusCode === StatusCodes.GoodWithOverflowBit) {
                self.queue[0].statusCode = StatusCodes.Good;
            }
        }
    }
    assert(self.queue.length <= self.queueSize);
};

MonitoredItem.prototype._adjust_sampling = function(old_samplingInterval) {

    var self = this;

    if (old_samplingInterval !== self.samplingInterval) {
        self._change_timer_timeout();
    }
};

MonitoredItem.prototype.modify = function (timestampsToReturn, options) {

    assert(options instanceof MonitoringParameters);

    var self = this;

    var old_queueSize         = self.queueSize;
    var old_samplingInterval  = self.samplingInterval;

    self.timestampsToReturn = timestampsToReturn || self.timestampsToReturn;

    self._set_parameters(options);

    self._adjust_queue_to_match_new_queue_size(old_queueSize);

    self._adjust_sampling(old_samplingInterval);

    // validate filter
    // note : The DataChangeFilter does not have an associated result structure.
    var filterResult = null; // new subscription_service.DataChangeFilter

    return new MonitoredItemModifyResult({
        statusCode:              StatusCodes.Good,
        revisedSamplingInterval: self.samplingInterval,
        revisedQueueSize:        self.queueSize,
        filterResult:            filterResult
    });
};

exports.MonitoredItem = MonitoredItem;
