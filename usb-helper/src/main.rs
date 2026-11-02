//! jace-usb-helper: gives Jace Browser's WebUSB support access to USB devices.
//!
//! Firefox has no WebUSB, so Jace Browser implements `navigator.usb` itself
//! (see src/jace/content/usb). The browser's parent process starts this
//! helper and talks to it with one JSON object per line:
//!
//!   request   {"id": 1, "cmd": "list"}
//!   response  {"id": 1, "ok": true, "result": ...}
//!             {"id": 1, "ok": false, "error": {"name": "NotFoundError", "message": "..."}}
//!   event     {"event": "connect", "device": {...}} / {"event": "disconnect", "guid": "..."}
//!
//! Each request runs on its own thread, so a long-pending transferIn (for
//! example an interrupt endpoint waiting for a key press) never blocks other
//! requests. The helper never decides which site may use which device: the
//! browser asks the person and only sends requests for devices they chose.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures_lite::{future::block_on, StreamExt};
use nusb::descriptors::Configuration;
use nusb::hotplug::HotplugEvent;
use nusb::transfer::{ControlIn, ControlOut, ControlType, Direction, EndpointType, Recipient, RequestBuffer, TransferError};
use nusb::{Device, DeviceId, DeviceInfo, Interface};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

/// Largest single transfer we accept, to keep a bad page from exhausting memory.
const MAX_TRANSFER: usize = 16 * 1024 * 1024;

struct OpenDevice {
    device: Device,
    interfaces: HashMap<u8, Interface>,
    /// endpoint address (with direction bit) -> interface number, for the active alt settings
    endpoints: HashMap<u8, (u8, EndpointType)>,
}

#[derive(Default)]
struct State {
    guids: HashMap<DeviceId, String>,
    infos: HashMap<String, DeviceInfo>,
    open: HashMap<String, Arc<Mutex<OpenDevice>>>,
    next: u64,
}

type Shared = Arc<Mutex<State>>;

struct UsbError {
    name: &'static str,
    message: String,
}

fn err(name: &'static str, message: impl Into<String>) -> UsbError {
    UsbError { name, message: message.into() }
}

impl From<std::io::Error> for UsbError {
    fn from(e: std::io::Error) -> Self {
        let name = match e.kind() {
            std::io::ErrorKind::PermissionDenied => "SecurityError",
            std::io::ErrorKind::NotFound => "NotFoundError",
            _ => "NetworkError",
        };
        err(name, e.to_string())
    }
}

impl From<TransferError> for UsbError {
    fn from(e: TransferError) -> Self {
        err("NetworkError", e.to_string())
    }
}

/// WebUSB reports a stall as a status instead of an exception.
fn transfer_status(e: &TransferError) -> Option<&'static str> {
    match e {
        TransferError::Stall => Some("stall"),
        _ => None,
    }
}

fn guid_for(state: &mut State, info: &DeviceInfo) -> String {
    let id = info.id();
    if let Some(g) = state.guids.get(&id) {
        state.infos.insert(g.clone(), info.clone());
        return g.clone();
    }
    state.next += 1;
    let guid = format!("usb-{:04x}-{:04x}-{}", info.vendor_id(), info.product_id(), state.next);
    state.guids.insert(id, guid.clone());
    state.infos.insert(guid.clone(), info.clone());
    guid
}

fn bcd(v: u16) -> (u8, u8, u8) {
    (((v >> 8) as u8 >> 4) * 10 + ((v >> 8) as u8 & 0xf), ((v >> 4) & 0xf) as u8, (v & 0xf) as u8)
}

fn endpoint_type(t: EndpointType) -> &'static str {
    match t {
        EndpointType::Bulk => "bulk",
        EndpointType::Interrupt => "interrupt",
        EndpointType::Isochronous => "isochronous",
        EndpointType::Control => "control",
    }
}

fn describe_config(c: &Configuration) -> Value {
    let interfaces: Vec<Value> = c
        .interfaces()
        .map(|group| {
            let alternates: Vec<Value> = group
                .alt_settings()
                .map(|alt| {
                    let endpoints: Vec<Value> = alt
                        .endpoints()
                        .map(|ep| {
                            json!({
                                "endpointNumber": ep.address() & 0x0f,
                                "direction": if ep.direction() == Direction::In { "in" } else { "out" },
                                "type": endpoint_type(ep.transfer_type()),
                                "packetSize": ep.max_packet_size(),
                            })
                        })
                        .collect();
                    json!({
                        "alternateSetting": alt.alternate_setting(),
                        "interfaceClass": alt.class(),
                        "interfaceSubclass": alt.subclass(),
                        "interfaceProtocol": alt.protocol(),
                        "interfaceName": Value::Null,
                        "endpoints": endpoints,
                    })
                })
                .collect();
            json!({ "interfaceNumber": group.interface_number(), "alternates": alternates })
        })
        .collect();
    json!({
        "configurationValue": c.configuration_value(),
        "configurationName": Value::Null,
        "interfaces": interfaces,
    })
}

fn describe(guid: &str, info: &DeviceInfo, device: Option<&Device>) -> Value {
    let (dmaj, dmin, dsub) = bcd(info.device_version());
    let mut v = json!({
        "guid": guid,
        "vendorId": info.vendor_id(),
        "productId": info.product_id(),
        "deviceClass": info.class(),
        "deviceSubclass": info.subclass(),
        "deviceProtocol": info.protocol(),
        "deviceVersionMajor": dmaj,
        "deviceVersionMinor": dmin,
        "deviceVersionSubminor": dsub,
        "usbVersionMajor": 2,
        "usbVersionMinor": 0,
        "usbVersionSubminor": 0,
        "manufacturerName": info.manufacturer_string(),
        "productName": info.product_string(),
        "serialNumber": info.serial_number(),
        "configurations": [],
        "configuration": Value::Null,
    });
    if let Some(device) = device {
        let configs: Vec<Value> = device.configurations().map(|c| describe_config(&c)).collect();
        v["configurations"] = Value::Array(configs);
        if let Ok(active) = device.active_configuration() {
            v["configuration"] = json!(active.configuration_value());
        }
        // bcdUSB lives in the device descriptor (bytes 2..4).
        if let Ok(desc) = device.get_descriptor(0x01, 0, 0, std::time::Duration::from_millis(500)) {
            if desc.len() >= 4 {
                let (maj, min, sub) = bcd(u16::from_le_bytes([desc[2], desc[3]]));
                v["usbVersionMajor"] = json!(maj);
                v["usbVersionMinor"] = json!(min);
                v["usbVersionSubminor"] = json!(sub);
            }
        }
    }
    v
}

fn list(state: &Shared) -> Result<Value, UsbError> {
    // No USB bus at all (e.g. a sandbox without /sys/bus/usb) means no devices, not an error.
    let infos: Vec<DeviceInfo> = match nusb::list_devices() {
        Ok(iter) => iter.collect(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let mut st = state.lock().unwrap();
    let mut out = Vec::new();
    for info in infos {
        let guid = guid_for(&mut st, &info);
        let open = st.open.get(&guid).cloned();
        let entry = match open {
            Some(od) => describe(&guid, &info, Some(&od.lock().unwrap().device)),
            None => describe(&guid, &info, None),
        };
        out.push(entry);
    }
    Ok(Value::Array(out))
}

fn str_arg<'a>(req: &'a Value, key: &str) -> Result<&'a str, UsbError> {
    req.get(key).and_then(Value::as_str).ok_or_else(|| err("TypeError", format!("missing {key}")))
}

fn u64_arg(req: &Value, key: &str) -> Result<u64, UsbError> {
    req.get(key).and_then(Value::as_u64).ok_or_else(|| err("TypeError", format!("missing {key}")))
}

fn opened(state: &Shared, req: &Value) -> Result<Arc<Mutex<OpenDevice>>, UsbError> {
    let guid = str_arg(req, "guid")?;
    state
        .lock()
        .unwrap()
        .open
        .get(guid)
        .cloned()
        .ok_or_else(|| err("InvalidStateError", "The device must be opened first."))
}

fn refresh_endpoints(od: &mut OpenDevice, iface: u8, alt: u8) {
    od.endpoints.retain(|_, (i, _)| *i != iface);
    if let Ok(cfg) = od.device.active_configuration() {
        for group in cfg.interfaces().filter(|g| g.interface_number() == iface) {
            for setting in group.alt_settings().filter(|a| a.alternate_setting() == alt) {
                for ep in setting.endpoints() {
                    od.endpoints.insert(ep.address(), (iface, ep.transfer_type()));
                }
            }
        }
    }
}

fn setup(req: &Value) -> Result<(ControlType, Recipient, u8, u16, u16), UsbError> {
    let s = req.get("setup").ok_or_else(|| err("TypeError", "missing setup"))?;
    let control_type = match s.get("requestType").and_then(Value::as_str) {
        Some("standard") => ControlType::Standard,
        Some("class") => ControlType::Class,
        Some("vendor") => ControlType::Vendor,
        _ => return Err(err("TypeError", "requestType must be standard, class or vendor")),
    };
    let recipient = match s.get("recipient").and_then(Value::as_str) {
        Some("device") => Recipient::Device,
        Some("interface") => Recipient::Interface,
        Some("endpoint") => Recipient::Endpoint,
        Some("other") => Recipient::Other,
        _ => return Err(err("TypeError", "recipient must be device, interface, endpoint or other")),
    };
    let n = |k: &str| s.get(k).and_then(Value::as_u64).ok_or_else(|| err("TypeError", format!("missing setup.{k}")));
    Ok((control_type, recipient, n("request")? as u8, n("value")? as u16, n("index")? as u16))
}

/// The interface a control transfer goes through: the one it addresses, or any claimed one.
fn control_interface(od: &OpenDevice, recipient: Recipient, index: u16) -> Option<Interface> {
    match recipient {
        Recipient::Interface => od.interfaces.get(&(index as u8)).cloned(),
        Recipient::Endpoint => od
            .endpoints
            .get(&(index as u8))
            .and_then(|(i, _)| od.interfaces.get(i).cloned()),
        _ => od.interfaces.values().next().cloned(),
    }
}

fn handle(state: &Shared, req: &Value) -> Result<Value, UsbError> {
    let cmd = str_arg(req, "cmd")?;
    match cmd {
        "hello" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "list" => list(state),
        "open" => {
            let guid = str_arg(req, "guid")?.to_string();
            let info = state
                .lock()
                .unwrap()
                .infos
                .get(&guid)
                .cloned()
                .ok_or_else(|| err("NotFoundError", "That device is no longer connected."))?;
            if let Some(od) = state.lock().unwrap().open.get(&guid) {
                return Ok(describe(&guid, &info, Some(&od.lock().unwrap().device)));
            }
            let device = info.open()?;
            let desc = describe(&guid, &info, Some(&device));
            let od = OpenDevice { device, interfaces: HashMap::new(), endpoints: HashMap::new() };
            state.lock().unwrap().open.insert(guid, Arc::new(Mutex::new(od)));
            Ok(desc)
        }
        "close" => {
            let guid = str_arg(req, "guid")?;
            state.lock().unwrap().open.remove(guid);
            Ok(Value::Null)
        }
        "selectConfiguration" => {
            let od = opened(state, req)?;
            let mut od = od.lock().unwrap();
            let value = u64_arg(req, "value")? as u8;
            od.interfaces.clear();
            od.endpoints.clear();
            od.device.set_configuration(value)?;
            Ok(Value::Null)
        }
        "claimInterface" => {
            let od = opened(state, req)?;
            let mut od = od.lock().unwrap();
            let n = u64_arg(req, "interface")? as u8;
            if !od.interfaces.contains_key(&n) {
                #[cfg(target_os = "linux")]
                let iface = od.device.detach_and_claim_interface(n)?;
                #[cfg(not(target_os = "linux"))]
                let iface = od.device.claim_interface(n)?;
                od.interfaces.insert(n, iface);
                refresh_endpoints(&mut od, n, 0);
            }
            Ok(Value::Null)
        }
        "releaseInterface" => {
            let od = opened(state, req)?;
            let mut od = od.lock().unwrap();
            let n = u64_arg(req, "interface")? as u8;
            od.interfaces.remove(&n);
            od.endpoints.retain(|_, (i, _)| *i != n);
            Ok(Value::Null)
        }
        "selectAlternateInterface" => {
            let od = opened(state, req)?;
            let mut od = od.lock().unwrap();
            let n = u64_arg(req, "interface")? as u8;
            let alt = u64_arg(req, "alternate")? as u8;
            let iface = od.interfaces.get(&n).cloned().ok_or_else(|| err("InvalidStateError", "Claim the interface first."))?;
            iface.set_alt_setting(alt)?;
            refresh_endpoints(&mut od, n, alt);
            Ok(Value::Null)
        }
        "controlTransferIn" => {
            let (control_type, recipient, request, value, index) = setup(req)?;
            let length = (u64_arg(req, "length")? as usize).min(0xffff) as u16;
            let od = opened(state, req)?;
            let (iface, device) = {
                let od = od.lock().unwrap();
                (control_interface(&od, recipient, index), od.device.clone())
            };
            let ctl = ControlIn { control_type, recipient, request, value, index, length };
            let completion = match iface {
                Some(i) => block_on(i.control_in(ctl)),
                None => {
                    #[cfg(any(target_os = "linux", target_os = "macos"))]
                    {
                        block_on(device.control_in(ctl))
                    }
                    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
                    {
                        let _ = device;
                        return Err(err("InvalidStateError", "Claim an interface before sending control transfers."));
                    }
                }
            };
            match completion.status {
                Ok(()) => Ok(json!({ "status": "ok", "data": B64.encode(&completion.data) })),
                Err(e) => match transfer_status(&e) {
                    Some(s) => Ok(json!({ "status": s, "data": "" })),
                    None => Err(e.into()),
                },
            }
        }
        "controlTransferOut" => {
            let (control_type, recipient, request, value, index) = setup(req)?;
            let data = B64.decode(req.get("data").and_then(Value::as_str).unwrap_or("")).map_err(|_| err("TypeError", "bad data"))?;
            let od = opened(state, req)?;
            let (iface, device) = {
                let od = od.lock().unwrap();
                (control_interface(&od, recipient, index), od.device.clone())
            };
            let ctl = ControlOut { control_type, recipient, request, value, index, data: &data };
            let completion = match iface {
                Some(i) => block_on(i.control_out(ctl)),
                None => {
                    #[cfg(any(target_os = "linux", target_os = "macos"))]
                    {
                        block_on(device.control_out(ctl))
                    }
                    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
                    {
                        let _ = device;
                        return Err(err("InvalidStateError", "Claim an interface before sending control transfers."));
                    }
                }
            };
            match completion.status {
                Ok(()) => Ok(json!({ "status": "ok", "bytesWritten": completion.data.actual_length() })),
                Err(e) => match transfer_status(&e) {
                    Some(s) => Ok(json!({ "status": s, "bytesWritten": 0 })),
                    None => Err(e.into()),
                },
            }
        }
        "transferIn" => {
            let ep = 0x80 | (u64_arg(req, "endpoint")? as u8 & 0x0f);
            let length = u64_arg(req, "length")? as usize;
            if length > MAX_TRANSFER {
                return Err(err("RangeError", "Transfer is too large."));
            }
            let od = opened(state, req)?;
            let (iface, kind) = endpoint_interface(&od, ep)?;
            let completion = match kind {
                EndpointType::Interrupt => block_on(iface.interrupt_in(ep, RequestBuffer::new(length))),
                EndpointType::Bulk => block_on(iface.bulk_in(ep, RequestBuffer::new(length))),
                _ => return Err(err("NotSupportedError", "Only bulk and interrupt endpoints are supported.")),
            };
            match completion.status {
                Ok(()) => Ok(json!({ "status": "ok", "data": B64.encode(&completion.data) })),
                Err(e) => match transfer_status(&e) {
                    Some(s) => Ok(json!({ "status": s, "data": "" })),
                    None => Err(e.into()),
                },
            }
        }
        "transferOut" => {
            let ep = u64_arg(req, "endpoint")? as u8 & 0x0f;
            let data = B64.decode(req.get("data").and_then(Value::as_str).unwrap_or("")).map_err(|_| err("TypeError", "bad data"))?;
            if data.len() > MAX_TRANSFER {
                return Err(err("RangeError", "Transfer is too large."));
            }
            let od = opened(state, req)?;
            let (iface, kind) = endpoint_interface(&od, ep)?;
            let completion = match kind {
                EndpointType::Interrupt => block_on(iface.interrupt_out(ep, data)),
                EndpointType::Bulk => block_on(iface.bulk_out(ep, data)),
                _ => return Err(err("NotSupportedError", "Only bulk and interrupt endpoints are supported.")),
            };
            match completion.status {
                Ok(()) => Ok(json!({ "status": "ok", "bytesWritten": completion.data.actual_length() })),
                Err(e) => match transfer_status(&e) {
                    Some(s) => Ok(json!({ "status": s, "bytesWritten": 0 })),
                    None => Err(e.into()),
                },
            }
        }
        "clearHalt" => {
            let n = u64_arg(req, "endpoint")? as u8 & 0x0f;
            let ep = if str_arg(req, "direction")? == "in" { 0x80 | n } else { n };
            let od = opened(state, req)?;
            let (iface, _) = endpoint_interface(&od, ep)?;
            iface.clear_halt(ep)?;
            Ok(Value::Null)
        }
        "reset" => {
            let od = opened(state, req)?;
            let device = od.lock().unwrap().device.clone();
            device.reset()?;
            Ok(Value::Null)
        }
        other => Err(err("NotSupportedError", format!("Unknown command {other}"))),
    }
}

fn endpoint_interface(od: &Arc<Mutex<OpenDevice>>, ep: u8) -> Result<(Interface, EndpointType), UsbError> {
    let od = od.lock().unwrap();
    let (n, kind) = od
        .endpoints
        .get(&ep)
        .copied()
        .ok_or_else(|| err("NotFoundError", "That endpoint isn't part of a claimed interface."))?;
    let iface = od.interfaces.get(&n).cloned().ok_or_else(|| err("InvalidStateError", "Claim the interface first."))?;
    Ok((iface, kind))
}

fn send(out: &Mutex<std::io::Stdout>, v: &Value) {
    let mut out = out.lock().unwrap();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn main() {
    let state: Shared = Arc::new(Mutex::new(State::default()));
    let out = Arc::new(Mutex::new(std::io::stdout()));

    // Hotplug events, so pages get navigator.usb "connect"/"disconnect".
    {
        let state = state.clone();
        let out = out.clone();
        std::thread::spawn(move || {
            let Ok(mut watch) = nusb::watch_devices() else { return };
            while let Some(event) = block_on(watch.next()) {
                match event {
                    HotplugEvent::Connected(info) => {
                        let guid = guid_for(&mut state.lock().unwrap(), &info);
                        send(&out, &json!({ "event": "connect", "device": describe(&guid, &info, None) }));
                    }
                    HotplugEvent::Disconnected(id) => {
                        let mut st = state.lock().unwrap();
                        if let Some(guid) = st.guids.remove(&id) {
                            st.infos.remove(&guid);
                            st.open.remove(&guid);
                            drop(st);
                            send(&out, &json!({ "event": "disconnect", "guid": guid }));
                        }
                    }
                }
            }
        });
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                send(&out, &json!({ "id": Value::Null, "ok": false, "error": { "name": "SyntaxError", "message": e.to_string() } }));
                continue;
            }
        };
        let state = state.clone();
        let out = out.clone();
        std::thread::spawn(move || {
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let reply = match handle(&state, &req) {
                Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                Err(e) => json!({ "id": id, "ok": false, "error": { "name": e.name, "message": e.message } }),
            };
            send(&out, &reply);
        });
    }
    // stdin closed: the browser quit. Open devices close as they drop.
}
