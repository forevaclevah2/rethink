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
// Fields this model actually populates (everything else comes back 0xFF):
//   [0]  monStatus       2      [10] displayLock      1  unlocked (1=unlocked 2=locked)
//   [1]  fridgeSetpoint  7   -> 37 °F   [14] sabbathMode  0  off
//   [2]  freezerSetpoint 9   -> -3 °F   [17] smartCare    0
//   [3]  expressFreeze   1      off     [25] craftIce     2
//   [4]  freshAirFilter  2              [26] monDataNumber 0
//   [5]  smartSaving     2
//   [6]  waterFilter     6
//   [7]  anyDoorOpen     0      closed
//   [8]  tempUnit        0      Fahrenheit
//   [9]  smartSavingRun  0
// Absent on this model (0xFF): activeSaving, ecoFriendly, convertibleTemp (no flex
// drawer — it is a 3-door), dualFridge, expressCool, drawerMode, pantryMode,
// voiceMode, dispenserMode/Capacity/Unit, selfCare.
//
// DELIBERATELY READ-ONLY. Reads are verified against the real appliance; writes
// are NOT. F017 is a server-to-device command and the appliance never emits one,
// so the correct command-frame length for this model cannot be learned by
// observation. Note that F017 length does not track status-body length either:
// 2REF11EIDA__4 has a 68-byte status and a 105-byte command, while 2REF11EBIVPC4
// has a 43-byte status and a 124-byte command. Sending a wrong-length F017 to a
// refrigerator could silently move setpoints, so nothing here advertises a
// command topic. See docs/2REF11EBIR__4.md for a safe bring-up order.

// Raw counters whose exact scale is not documented anywhere we can verify. They
// are published as diagnostics with their raw byte value rather than being given
// an invented unit or mapping.
const RAW_DIAGNOSTICS: ReadonlyArray<{ prop: string; index: number; name: string; icon: string }> = [
    { prop: 'water_filter', index: 6, name: 'Water filter', icon: 'mdi:water-check' },
    { prop: 'fresh_air_filter', index: 4, name: 'Fresh air filter', icon: 'mdi:air-filter' },
    { prop: 'craft_ice', index: 25, name: 'Craft ice', icon: 'mdi:ice-cream' },
]

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
        const degrees = unit === 'F' ? '°F' : '°C'

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
                        unit_of_measurement: degrees,
                    },
                    freezer_setpoint: {
                        platform: 'sensor',
                        device_class: 'temperature',
                        unique_id: '$deviceid-freezer_setpoint',
                        state_topic: '$this/freezer_setpoint',
                        name: 'Freezer temperature',
                        unit_of_measurement: degrees,
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
                    sabbath_mode: {
                        platform: 'binary_sensor',
                        icon: 'mdi:candle',
                        unique_id: '$deviceid-sabbath_mode',
                        state_topic: '$this/sabbath_mode',
                        name: 'Sabbath mode',
                    },
                    display_lock: {
                        platform: 'binary_sensor',
                        device_class: 'lock',
                        unique_id: '$deviceid-display_lock',
                        state_topic: '$this/display_lock',
                        name: 'Control panel lock',
                    },
                    ...Object.fromEntries(
                        RAW_DIAGNOSTICS.map(({ prop, name, icon }) => [
                            prop,
                            {
                                platform: 'sensor',
                                entity_category: 'diagnostic',
                                icon,
                                unique_id: `$deviceid-${prop}`,
                                state_topic: `$this/${prop}`,
                                name,
                            },
                        ]),
                    ),
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
        // processStatus already skips anything past the end of the buffer.
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

    // 0xFF means "not supported on this model", and a short buffer means the field
    // is not present at all. Both are left unpublished so the entity stays unknown
    // rather than reporting a fabricated value.
    private field(status: Buffer, index: number) {
        if (index >= status.length) return undefined
        const v = status[index]
        return v === 0xff ? undefined : v
    }

    processStatus(curStatus: Buffer) {
        // Field order is fridge_common.STATUS_FIELDS; see the capture above.
        const unit: TemperatureUnit = curStatus[8] ? 'C' : 'F'
        this.setTemperatureUnit(unit)

        const fridge = this.field(curStatus, 1)
        if (fridge !== undefined) this.publishProperty('fridge_setpoint', convertFridgeTemperature(unit, fridge))

        const freezer = this.field(curStatus, 2)
        if (freezer !== undefined) this.publishProperty('freezer_setpoint', convertFreezerTemperature(unit, freezer))

        const door = this.field(curStatus, 7)
        if (door !== undefined) this.publishProperty('door', door === 1 ? 'ON' : 'OFF')

        const expressFreeze = this.field(curStatus, 3)
        if (expressFreeze !== undefined) this.publishProperty('express_freeze', expressFreeze === 2 ? 'ON' : 'OFF')

        const sabbath = this.field(curStatus, 14)
        if (sabbath !== undefined) this.publishProperty('sabbath_mode', sabbath === 1 ? 'ON' : 'OFF')

        // 1=unlocked, 2=locked (per 2REF11EIDA__4). ON means locked, to match device_class 'lock'.
        const displayLock = this.field(curStatus, 10)
        if (displayLock !== undefined) this.publishProperty('display_lock', displayLock === 2 ? 'ON' : 'OFF')

        for (const { prop, index } of RAW_DIAGNOSTICS) {
            const v = this.field(curStatus, index)
            if (v !== undefined) this.publishProperty(prop, v)
        }
    }
}
