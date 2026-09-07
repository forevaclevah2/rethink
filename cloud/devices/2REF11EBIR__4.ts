import HADevice from './base'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { allowExtendedType } from '@/util/casting'
import AABBDevice from './aabb_device'
import { convertFreezerTemperature, convertFridgeTemperature, TemperatureUnit } from './fridge_common'

// 2REF11EBIR__4 — LG LF21G6200S / GV-B218HSNB.ASTCNA0 (US 3-door counter-depth, ADA)
// DeviceType 101, RTK_RTL8720cm, clip_v2.00.15.05-SDK-8-RELEASE.
//
// This is a TRUNCATED-BUFFER VARIANT of the shared fridge status layout that
// 2REF11EIDA__4 uses — same 10EB/10EC opcodes, same field order (see
// fridge_common.STATUS_FIELDS), but a 65-byte status body instead of 68.
// fridge_common already anticipates this: "The buffer is truncated for lower-end
// models", and unpackStatus() is written to tolerate short buffers.
//
// Captured from a live unit, 2026-09-07, in reply to the F0ED status query:
//   AA4710EB0207090102020600000001FFFFFF00FFFF00FFFFFFFFFFFFFF02000101FF0000FF01FF64
//   00FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF007890BB
//   frame 71 B, declared len 0x47, checksum 0x90 verified, inner 67 B -> body 65 B
//
// Decoded from that capture (all values physically sensible, LG factory defaults):
//   [1]  fridgeSetpoint  = 7    -> 37 °F (44 - 7)
//   [2]  freezerSetpoint = 9    -> -3 °F (6 - 9)
//   [3]  expressFreeze   = 1    -> off (1=off, 2=on)
//   [7]  anyDoorOpen     = 0    -> closed
//   [8]  tempUnit        = 0    -> Fahrenheit
//   [10] displayLock     = 1    -> unlocked
//   [13] convertibleTemp = 0xFF -> N/A: this is a 3-door, it has no flex drawer
//
// DELIBERATELY READ-ONLY. Reads are verified against the real appliance; writes
// are NOT. 2REF11EIDA__4 commands with a 0x69-length F017 frame sized for its
// 68-byte layout, and this model's write frame length is unknown. Sending a
// wrong-length F017 to a refrigerator could silently move setpoints, so the
// setpoints are exposed as sensors rather than numbers until an F017 round-trip
// has actually been observed on this model. See docs/2REF11EBIR__4.md to enable
// control once verified.

export default class Device extends AABBDevice {
    readonly deviceConfig: DeviceDiscovery
    temperatureUnit: TemperatureUnit | undefined

    // Body length observed on a live unit. Kept as a named constant because the
    // whole point of this handler is that it differs from 2REF11EIDA__4's 68.
    static readonly STATUS_LENGTH = 65

    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq)
        this.deviceConfig = HADevice.config(meta, { name: 'LG Fridge' })

        // HomeAssistant configuration is published once we know the temperature unit
    }

    setTemperatureUnit(unit: TemperatureUnit) {
        if (this.temperatureUnit === unit) return

        this.temperatureUnit = unit
        this.setConfig(
            allowExtendedType({
                ...this.deviceConfig,
                components: {
                    fridge_setpoint: {
                        platform: 'sensor',
                        device_class: 'temperature',
                        unique_id: '$deviceid-fridge_setpoint',
                        state_topic: '$this/fridge_setpoint',
                        name: 'Fridge temperature',
                        unit_of_measurement: unit === 'F' ? '°F' : '°C',
                    },
                    freezer_setpoint: {
                        platform: 'sensor',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        name: 'Freezer temperature',
                        unit_of_measurement: unit === 'F' ? '°F' : '°C',
                    },
                    door: {
                        platform: 'binary_sensor',
                        device_class: 'door',
                        unique_id: '$deviceid-door',
                        state_topic: '$this/door',
                        name: 'Door',
                    },
                    express_freeze: {
                        platform: 'binary_sensor',
                        icon: 'mdi:snowflake',
                        unique_id: '$deviceid-express_freeze',
                        state_topic: '$this/express_freeze',
                        name: 'Express Freeze',
                    },
                },
            }),
        )
    }

    start() {
        // Same family-wide status query 2REF11EIDA__4 sends. Verified against this
        // model: it answers in ~200 ms with the 10EB frame quoted above. Without it
        // the unit only emits its own 100A telemetry and never reports 10EB/10EC.
        this.send(Buffer.from('F0ED1211010000010400', 'hex'))
    }

    processAABB(buf: Buffer) {
        if (buf.length < 3 || buf[0] !== 0x10) return

        const body = buf.subarray(2)

        // 10EB: [initial status]. Observed at exactly STATUS_LENGTH.
        // Matched on a range rather than equality so a firmware update that pads or
        // trims a byte degrades to "some fields missing" instead of going silent —
        // unpackStatus/processStatus already tolerate a short buffer.
        if (buf[1] === 0xeb && body.length >= 34) {
            this.processStatus(body)
            return
        }

        // 10EC: [prev status][cur status], two equal halves. Not yet observed on this
        // model — 2REF11EIDA__4 receives it, so handle it by the same shape and take
        // the current half.
        if (buf[1] === 0xec && body.length >= 68 && body.length % 2 === 0) {
            this.processStatus(body.subarray(body.length / 2))
        }
    }

    processStatus(curStatus: Buffer) {
        // Field order is fridge_common.STATUS_FIELDS; see the capture above.
        const unit: TemperatureUnit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        this.publishProperty('fridge_setpoint', convertFridgeTemperature(unit, curStatus[1]))
        this.publishProperty('freezer_setpoint', convertFreezerTemperature(unit, curStatus[2]))
        this.publishProperty('door', curStatus[7] === 1 ? 'ON' : 'OFF')

        // 0xFF means "not supported on this model" — leave the entity unknown rather
        // than reporting a fabricated OFF.
        if (curStatus[3] !== 0xff) {
            this.publishProperty('express_freeze', curStatus[3] === 2 ? 'ON' : 'OFF')
        }
    }
}
