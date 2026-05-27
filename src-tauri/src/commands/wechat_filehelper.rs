use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use image::{ImageBuffer, Luma};
use qrcode::QrCode;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::Manager;

// ── Managed State ──────────────────────────────────────────────────────────

pub struct WechatFilehelperState {
    inner: Mutex<WechatFilehelperInner>,
}

#[derive(Default)]
struct WechatFilehelperInner {
    skey: String,
    sid: String,
    uin: String,
    pass_ticket: String,
    synckey: String,
    device_id: String,
    nickname: String,
    avatar_url: String,
    user_name: String,
    cookies: HashMap<String, String>,
    // Resolved hosts from redirect
    sync_host: String,
    file_host: String,
    logged_in: bool,
}

impl Default for WechatFilehelperState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(WechatFilehelperInner::default()),
        }
    }
}

// ── Public API types (returned to frontend) ────────────────────────────────

#[derive(Serialize, Clone)]
pub struct QrResponse {
    pub qrcode_id: String,
    pub qr_img_url: String,
}

#[derive(Serialize, Clone)]
pub struct LoginStatus {
    pub status: String,
    pub message: String,
    pub nickname: Option<String>,
    pub avatar_url: Option<String>,
    pub wxid: Option<String>,
    pub session_token: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct UserInfo {
    pub nickname: String,
    pub avatar_url: String,
    pub wxid: String,
}

#[derive(Serialize, Clone)]
pub struct WechatCardInfo {
    pub title: String,
    pub description: String,
    pub url: String,
    #[serde(rename = "thumbUrl")]
    pub thumb_url: String,
    #[serde(rename = "appName")]
    pub app_name: String,
}

#[derive(Serialize, Clone)]
pub struct WechatMessage {
    #[serde(rename = "msgId")]
    pub msg_id: String,
    #[serde(rename = "type")]
    pub msg_type: i32,
    #[serde(rename = "fromUser")]
    pub from_user: String,
    #[serde(rename = "toUser")]
    pub to_user: String,
    pub content: String,
    #[serde(rename = "createTime")]
    pub create_time: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<WechatCardInfo>,
}

#[derive(Serialize, Clone)]
pub struct SyncResponse {
    pub messages: Vec<WechatMessage>,
    #[serde(rename = "syncKey")]
    pub sync_key: String,
    #[serde(rename = "continue")]
    pub has_more: bool,
    /// "0" = ok, "1100" or "1101" = logged out elsewhere
    pub retcode: String,
    /// "0" = no new messages, "2" = new messages, "7" = kicked
    pub selector: String,
}

// ── Webwx response types ───────────────────────────────────────────────────

#[derive(Deserialize)]
struct WebwxInitResponse {
    #[serde(rename = "BaseResponse")]
    #[allow(dead_code)]
    base_response: WebwxBaseResponse,
    #[allow(dead_code)]
    #[serde(rename = "User")]
    user: Option<WebwxUser>,
    #[serde(rename = "SyncKey")]
    sync_key: Option<WebwxSyncKeyData>,
}

#[derive(Deserialize)]
struct WebwxBaseResponse {
    #[allow(dead_code)]
    #[serde(rename = "Ret")]
    ret: Option<i32>,
}

#[derive(Deserialize)]
struct WebwxUser {
    #[serde(rename = "UserName")]
    user_name: Option<String>,
    #[serde(rename = "NickName")]
    nick_name: Option<String>,
    #[serde(rename = "HeadImgUrl")]
    head_img_url: Option<String>,
}

#[derive(Deserialize)]
struct WebwxSyncKeyData {
    #[serde(rename = "List")]
    list: Vec<WebwxSyncKeyItem>,
    #[serde(rename = "Count")]
    #[allow(dead_code)]
    count: Option<i32>,
}

#[derive(Serialize, Deserialize)]
struct WebwxSyncKeyItem {
    #[serde(rename = "Key")]
    key: i32,
    #[serde(rename = "Val")]
    val: i64,
}

#[derive(Deserialize)]
struct WebwxSyncResponse {
    #[serde(rename = "BaseResponse")]
    #[allow(dead_code)]
    base_response: WebwxBaseResponse,
    #[serde(rename = "SyncKey")]
    sync_key: Option<WebwxSyncKeyData>,
    #[serde(rename = "AddMsgCount")]
    add_msg_count: Option<i32>,
    #[serde(rename = "AddMsgList")]
    add_msg_list: Option<Vec<WebwxMessage>>,
}

#[derive(Deserialize)]
struct WebwxMessage {
    #[serde(rename = "MsgId")]
    msg_id: Option<String>,
    #[serde(rename = "MsgType")]
    msg_type: Option<i32>,
    #[serde(rename = "FromUserName")]
    from_user_name: Option<String>,
    #[serde(rename = "ToUserName")]
    to_user_name: Option<String>,
    #[serde(rename = "Content")]
    content: Option<String>,
    #[serde(rename = "CreateTime")]
    create_time: Option<i64>,
    #[serde(rename = "AppMsgType")]
    app_msg_type: Option<i32>,
    #[serde(rename = "MediaId")]
    media_id: Option<String>,
    #[serde(rename = "FileSize")]
    file_size: Option<String>,
    #[serde(rename = "FileName")]
    file_name: Option<String>,
    #[serde(rename = "EncryFileName")]
    encry_file_name: Option<String>,
    #[serde(rename = "ImgBuf")]
    img_buf: Option<WebwxImageBuf>,
    #[serde(rename = "Url")]
    #[allow(dead_code)]
    url: Option<String>,
}

#[derive(Deserialize)]
struct WebwxImageBuf {
    #[serde(rename = "Buffer")]
    buffer: Option<String>,
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn generate_device_id() -> String {
    let n: u64 = rand::thread_rng().gen_range(100000000000000..999999999999999);
    format!("e{n}")
}

fn url_encode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(b as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", b));
            }
        }
    }
    result
}

fn cookie_header(cookies: &HashMap<String, String>) -> String {
    cookies
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn store_cookies(cookies: &mut HashMap<String, String>, response: &ureq::Response) {
    let mut raw_values: Vec<String> = response
        .all("set-cookie")
        .into_iter()
        .map(|v| v.to_string())
        .collect();
    if raw_values.is_empty() {
        raw_values = response
            .headers_names()
            .iter()
            .filter(|n| n.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|n| response.header(n).map(|v| v.to_string()))
            .collect();
    }

    for raw in raw_values {
        for segment in split_set_cookie_header(&raw) {
            let segment = segment.trim();
            if segment.is_empty() {
                continue;
            }
            if let Some(semicolon_pos) = segment.find(';') {
                let pair = &segment[..semicolon_pos];
                if let Some(eq) = pair.find('=') {
                    let key = pair[..eq].trim().to_string();
                    let val = pair[eq + 1..].trim().to_string();
                    if !key.is_empty() {
                        cookies.insert(key, val);
                    }
                }
            }
        }
    }
}

fn split_set_cookie_header(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let bytes = raw.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] != b',' {
            continue;
        }
        let rest = raw[i + 1..].trim_start();
        let eq_pos = rest.find('=');
        let semi_pos = rest.find(';').unwrap_or(usize::MAX);
        if matches!(eq_pos, Some(eq) if eq < semi_pos) {
            out.push(raw[start..i].to_string());
            start = i + 1;
        }
    }
    out.push(raw[start..].to_string());
    out
}

fn http_get(
    url: &str,
    cookies: &HashMap<String, String>,
    extra_headers: &[(&str, &str)],
) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(30))
        .build();
    let cookie_str = cookie_header(cookies);
    let mut req = agent
        .get(url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
        .set("Accept", "application/json, text/plain, */*");
    if !cookie_str.is_empty() {
        req = req.set("Cookie", &cookie_str);
    }
    for (k, v) in extra_headers {
        req = req.set(k, v);
    }
    req.call().map_err(|e| format!("HTTP GET {url}: {e}"))
}

/// Manual redirect following — captures cookies at every hop, returns (body, final_url).
fn http_get_manual_redirect(
    url: &str,
    cookies: &mut HashMap<String, String>,
    extra_headers: &[(&str, &str)],
) -> Result<(String, String), String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(30))
        .redirects(0)
        .build();

    let mut current_url = url.to_string();

    for _ in 0..10 {
        let cookie_str = cookie_header(cookies);
        eprintln!("[wechat] manual_redirect GET {current_url}");
        eprintln!("[wechat] manual_redirect cookies sent: {cookie_str}");
        let mut req = agent
            .get(&current_url)
            .set(
                "User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            )
            .set("Accept", "application/json, text/plain, */*")
            .set("Referer", "https://wx.qq.com/")
            .set("Origin", "https://wx.qq.com");
        if !cookie_str.is_empty() {
            req = req.set("Cookie", &cookie_str);
        }
        for (k, v) in extra_headers {
            req = req.set(k, v);
        }

        let resp = req
            .call()
            .map_err(|e| format!("HTTP GET {current_url}: {e}"))?;
        let status = resp.status();
        eprintln!("[wechat] manual_redirect status: {status}");

        // Log all Set-Cookie headers
        let set_cookie_headers: Vec<String> = resp
            .headers_names()
            .iter()
            .filter(|n| n.eq_ignore_ascii_case("set-cookie"))
            .filter_map(|n| resp.header(n).map(|v| v.to_string()))
            .collect();
        eprintln!(
            "[wechat] manual_redirect set-cookie headers: {:?}",
            set_cookie_headers
        );

        store_cookies(cookies, &resp);
        eprintln!(
            "[wechat] manual_redirect cookies after store: {:?}",
            cookies.keys().collect::<Vec<_>>()
        );

        if status == 301 || status == 302 || status == 307 || status == 308 {
            if let Some(location) = resp.header("Location") {
                eprintln!("[wechat] manual_redirect following redirect to: {location}");
                current_url = location.to_string();
                continue;
            }
        }

        let body = resp.into_string().map_err(|e| format!("read body: {e}"))?;
        eprintln!(
            "[wechat] manual_redirect final body (first 200): {}",
            &body[..body.len().min(300)]
        );
        return Ok((body, current_url));
    }

    Err("Too many redirects".to_string())
}

fn http_post_json(
    url: &str,
    cookies: &HashMap<String, String>,
    body: serde_json::Value,
) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(30))
        .build();
    let cookie_str = cookie_header(cookies);
    let body_str = serde_json::to_string(&body).unwrap_or_default();
    agent
        .post(url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
        .set("Content-Type", "application/json;charset=UTF-8")
        .set("Cookie", &cookie_str)
        .set("mmweb_appid", "wx_webfilehelper")
        .send_string(&body_str)
        .map_err(|e| format!("HTTP POST {url}: {e}"))
}

fn http_get_raw(url: &str, cookies: &HashMap<String, String>) -> Result<ureq::Response, String> {
    // synccheck is a long-poll endpoint: server holds ~25s, respond on new msg or timeout
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(35))
        .build();
    let cookie_str = cookie_header(cookies);
    agent
        .get(url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
        .set("Cookie", &cookie_str)
        .set("mmweb_appid", "wx_webfilehelper")
        .call()
        .map_err(|e| format!("HTTP GET {url}: {e}"))
}

fn http_get_download(
    url: &str,
    cookies: &HashMap<String, String>,
) -> Result<ureq::Response, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(35))
        .build();
    let cookie_str = cookie_header(cookies);
    let mut req = agent
        .get(url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        )
        .set("Accept", "*/*")
        .set("Referer", "https://filehelper.weixin.qq.com/")
        .set("mmweb_appid", "wx_webfilehelper");
    if !cookie_str.is_empty() {
        req = req.set("Cookie", &cookie_str);
    }
    req.call().map_err(|e| format!("HTTP GET {url}: {e}"))
}

// ── QR Code generation ────────────────────────────────────────────────────

fn generate_qr_png_data_url(text: &str) -> Result<String, String> {
    let code = QrCode::new(text.as_bytes()).map_err(|e| format!("QR generation: {e}"))?;
    let module_size = 4u32;
    let quiet = 8u32;
    let width = code.width();
    let img_w = width as u32 * module_size + quiet * 2;
    let mut img: ImageBuffer<Luma<u8>, Vec<u8>> =
        ImageBuffer::from_pixel(img_w, img_w, Luma([255u8]));
    for y in 0..width {
        for x in 0..width {
            if code[(x, y)] == qrcode::Color::Dark {
                let px = x as u32 * module_size + quiet;
                let py = y as u32 * module_size + quiet;
                for dy in 0..module_size {
                    for dx in 0..module_size {
                        img.put_pixel(px + dx, py + dy, Luma([0u8]));
                    }
                }
            }
        }
    }
    let mut png = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode: {e}"))?;
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&png)
    ))
}

fn parse_url_query(url: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    // Extract domain
    if let Some(domain_start) = url.find("://") {
        let rest = &url[domain_start + 3..];
        if let Some(slash) = rest.find('/') {
            map.insert("domain".to_string(), rest[..slash].to_string());
        }
    }
    // Extract query params
    if let Some(q) = url.find('?') {
        let query = &url[q + 1..];
        for pair in query.split('&') {
            if let Some(eq) = pair.find('=') {
                let key = &pair[..eq];
                let val = &pair[eq + 1..];
                map.insert(key.to_string(), val.to_string());
            }
        }
    }
    map
}

fn extract_skey(xml: &str) -> Option<String> {
    xml.find("<skey>")
        .and_then(|i| xml[i + 6..].find("</skey>").map(|j| &xml[i + 6..i + 6 + j]))
        .map(|s| s.to_string())
}

fn extract_wxsid(xml: &str) -> Option<String> {
    xml.find("<wxsid>")
        .and_then(|i| {
            xml[i + 7..]
                .find("</wxsid>")
                .map(|j| &xml[i + 7..i + 7 + j])
        })
        .map(|s| s.to_string())
}

fn extract_wxuin(xml: &str) -> Option<String> {
    xml.find("<wxuin>")
        .and_then(|i| {
            xml[i + 7..]
                .find("</wxuin>")
                .map(|j| &xml[i + 7..i + 7 + j])
        })
        .map(|s| s.to_string())
}

fn extract_pass_ticket(xml: &str) -> Option<String> {
    xml.find("<pass_ticket>")
        .and_then(|i| {
            xml[i + 13..]
                .find("</pass_ticket>")
                .map(|j| &xml[i + 13..i + 13 + j])
        })
        .map(|s| s.to_string())
}

fn extract_xml_tag(xml: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    xml.find(&open)
        .and_then(|i| {
            xml[i + open.len()..]
                .find(&close)
                .map(|j| &xml[i + open.len()..i + open.len() + j])
        })
        .unwrap_or("")
        .to_string()
}

fn decode_xml_attr(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn extract_xml_attr(xml: &str, attr: &str) -> String {
    let pattern = format!("{attr}=\"");
    xml.find(&pattern)
        .and_then(|i| {
            let start = i + pattern.len();
            xml[start..]
                .find('"')
                .map(|j| decode_xml_attr(&xml[start..start + j]))
        })
        .unwrap_or_default()
}

fn extract_xml_tag_or_attr(xml: &str, name: &str) -> String {
    let tag_value = extract_xml_tag(xml, name);
    if !tag_value.is_empty() {
        return decode_xml_attr(tag_value.trim());
    }
    let attr_value = extract_xml_attr(xml, name);
    if !attr_value.is_empty() {
        return attr_value;
    }

    let decoded_xml = decode_xml_attr(xml);
    if decoded_xml == xml {
        return String::new();
    }

    let tag_value = extract_xml_tag(&decoded_xml, name);
    if !tag_value.is_empty() {
        return decode_xml_attr(tag_value.trim());
    }
    extract_xml_attr(&decoded_xml, name)
}

fn first_direct_image_url(raw_content: &str) -> String {
    for attr in ["tpthumburl", "cdnthumburl", "cdnmidimgurl"] {
        let url = extract_xml_attr(raw_content, attr);
        if url.starts_with("http://") || url.starts_with("https://") {
            return url;
        }
    }
    String::new()
}

#[derive(Debug, Default)]
struct FileAttachInfo {
    cdn_attach_url: String,
    aes_key: String,
    attach_id: String,
    svr_id: String,
}

fn extract_file_attach_info(raw_content: &str) -> FileAttachInfo {
    FileAttachInfo {
        cdn_attach_url: extract_xml_tag_or_attr(raw_content, "cdnattachurl"),
        aes_key: extract_xml_tag_or_attr(raw_content, "aeskey"),
        attach_id: extract_xml_tag_or_attr(raw_content, "attachid"),
        svr_id: extract_xml_tag_or_attr(raw_content, "svrid"),
    }
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    let value = value.trim();
    if value.is_empty() {
        return;
    }
    if !values.iter().any(|existing| existing == value) {
        values.push(value.to_string());
    }
}

fn candidate_file_hosts(primary: &str) -> Vec<String> {
    let mut hosts = Vec::new();
    push_unique(&mut hosts, primary);
    push_unique(&mut hosts, "file.wx.qq.com");
    push_unique(&mut hosts, "file.wx2.qq.com");
    hosts
}

fn parse_appmsg_card(xml: &str) -> Option<WechatCardInfo> {
    let title = extract_xml_tag(xml, "title");
    let url = extract_xml_tag(xml, "url");
    // Card without URL is not useful
    if title.is_empty() && url.is_empty() {
        return None;
    }
    Some(WechatCardInfo {
        title: title.clone(),
        description: extract_xml_tag(xml, "des"),
        url,
        thumb_url: extract_xml_tag(xml, "thumburl"),
        app_name: extract_xml_tag(xml, "appname"),
    })
}

// ── Tauri Commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn wechat_get_login_qr(
    state: tauri::State<'_, WechatFilehelperState>,
) -> Result<QrResponse, String> {
    let device_id = generate_device_id();

    // Step 1: jslogin — get UUID
    let jslogin_url = format!(
        "https://login.wx.qq.com/jslogin?appid=wx_webfilehelper&fun=new&lang=zh_CN&redirect_uri=https%3A%2F%2Ffilehelper.weixin.qq.com%2Fcgi-bin%2Fmmwebwx-bin%2Fwebwxnewloginpage&_={}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );

    let mut cookies: HashMap<String, String> = HashMap::new();
    let resp = http_get(&jslogin_url, &cookies, &[])?;
    store_cookies(&mut cookies, &resp);
    let body = resp
        .into_string()
        .map_err(|e| format!("jslogin read: {e}"))?;

    let uuid = body
        .lines()
        .find(|l| l.contains("QRLogin.uuid"))
        .and_then(|l| {
            let start = l.find('"')? + 1;
            let end = l[start..].find('"')?;
            Some(l[start..start + end].to_string())
        })
        .ok_or_else(|| format!("jslogin: no uuid in response: {body}"))?;

    // Step 2: Generate QR PNG from the login URL
    let qr_text = format!("https://login.weixin.qq.com/l/{uuid}", uuid = &uuid);
    let qr_img_url = generate_qr_png_data_url(&qr_text)?;

    // Store uuid + device_id for polling
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.device_id = device_id;
        // stash uuid in cookies map so check_login can find it
        inner.cookies = cookies;
        inner.cookies.insert("_qr_uuid".to_string(), uuid.clone());
    }

    Ok(QrResponse {
        qrcode_id: uuid,
        qr_img_url,
    })
}

#[tauri::command]
pub async fn wechat_check_login(
    app: tauri::AppHandle,
    state: tauri::State<'_, WechatFilehelperState>,
    qrcode_id: String,
) -> Result<LoginStatus, String> {
    let (mut cookies, device_id) = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        (inner.cookies.clone(), inner.device_id.clone())
    };

    let tip = cookies
        .get("_qr_tip")
        .cloned()
        .unwrap_or_else(|| "1".to_string());

    let login_url = format!(
        "https://login.wx.qq.com/cgi-bin/mmwebwx-bin/login?loginicon=true&uuid={uuid}&tip={tip}&r={r}&_={ts}",
        uuid = url_encode(&qrcode_id),
        tip = tip,
        r = rand::thread_rng().gen_range(1000..9999),
        ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    );

    let resp = http_get(&login_url, &cookies, &[])?;
    store_cookies(&mut cookies, &resp);
    let body = resp
        .into_string()
        .map_err(|e| format!("login poll read: {e}"))?;

    // Parse window.code=... (response may contain multiple ;-separated assignments)
    let code = body
        .lines()
        .find(|l| l.contains("window.code="))
        .and_then(|l| {
            let eq = l.find("window.code=")?;
            let after = &l[eq + 12..]; // "window.code=" is 12 chars
            let end = after.find(';').unwrap_or(after.len());
            after[..end].trim().to_string().into()
        })
        .unwrap_or_default();

    match code.as_str() {
        "200" => {
            let redirect_uri = body
                .lines()
                .find(|l| l.contains("window.redirect_uri="))
                .and_then(|l| {
                    let eq = l.find('=')?;
                    let start = l[eq + 1..].find('"')? + eq + 2;
                    let end = l[start + 1..].find('"')?;
                    Some(l[start..start + 1 + end].to_string())
                })
                .ok_or_else(|| "login confirmed but no redirect_uri".to_string())?;

            // Step: webwxnewloginpage — get session credentials (XML)
            //
            // Match the reference implementation (wx-filehelper-api):
            // Parse the redirect_uri to extract domain + query params (ticket,
            // uuid, scan), then construct a fresh GET request to webwxnewloginpage.
            // We must NOT simply follow the redirect_uri — the newlogin page
            // requires specific query parameters.
            let parsed_redirect = parse_url_query(&redirect_uri);
            let newlogin_domain = parsed_redirect
                .get("domain")
                .cloned()
                .unwrap_or_else(|| "szfilehelper.weixin.qq.com".to_string());
            let ticket = parsed_redirect.get("ticket").cloned().unwrap_or_default();
            let redirect_uuid = parsed_redirect.get("uuid").cloned().unwrap_or_default();
            let scan = parsed_redirect.get("scan").cloned().unwrap_or_default();

            let newlogin_url = format!(
                "https://{domain}/cgi-bin/mmwebwx-bin/webwxnewloginpage?fun=new&version=v2&ticket={ticket}&uuid={uuid}&lang=zh_CN&scan={scan}",
                domain = newlogin_domain,
                ticket = url_encode(&ticket),
                uuid = url_encode(&redirect_uuid),
                scan = url_encode(&scan),
            );

            eprintln!("[wechat] newlogin URL: {newlogin_url}");

            // Direct GET — reference impl doesn't follow redirects here,
            // it just reads the XML response directly.
            let xml = http_get_manual_redirect(
                &newlogin_url,
                &mut cookies,
                &[("mmweb_appid", "wx_webfilehelper")],
            )?
            .0;
            let final_host = newlogin_domain;
            // The sync host is the final host from the login redirect chain.
            // szfilehelper.weixin.qq.com serves both the login page and all
            // sync API calls (webwxinit, synccheck, webwxsync).
            // file.wx2.qq.com is ONLY for file downloads (webwxgetmedia),
            // not for API calls — it returns 404 for webwxinit.
            let file_host = resolve_file_host(&final_host);
            let sync_host = final_host.clone();
            eprintln!("[wechat] redirect final host: {final_host} -> sync: {sync_host}, file: {file_host}");

            let skey =
                extract_skey(&xml).ok_or_else(|| "No skey in newlogin response".to_string())?;
            let wxsid =
                extract_wxsid(&xml).ok_or_else(|| "No wxsid in newlogin response".to_string())?;
            let wxuin =
                extract_wxuin(&xml).ok_or_else(|| "No wxuin in newlogin response".to_string())?;
            let pass_ticket = extract_pass_ticket(&xml)
                .ok_or_else(|| "No pass_ticket in newlogin response".to_string())?;

            // Hosts already resolved above from the final redirect URL

            // webwxinit — pass_ticket must be URL-encoded (reference impl uses
            // httpx params which encodes query values; WeChat expects this)
            let init_url = format!(
                "https://{sync_host}/cgi-bin/mmwebwx-bin/webwxinit?r={r}&lang=zh_CN&pass_ticket={pt}",
                sync_host = sync_host,
                r = !((std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis()) as i64),
                pt = url_encode(&pass_ticket),
            );

            let init_body = serde_json::json!({
                "BaseRequest": {
                    "Uin": wxuin.parse::<i64>().unwrap_or(0),
                    "Sid": &wxsid,
                    "Skey": &skey,
                    "DeviceID": &device_id,
                }
            });

            let init_resp = http_post_json(&init_url, &cookies, init_body)?;
            store_cookies(&mut cookies, &init_resp);
            let init_text = init_resp
                .into_string()
                .map_err(|e| format!("webwxinit read: {e}"))?;
            let init_data: WebwxInitResponse = serde_json::from_str(&init_text)
                .map_err(|e| format!("webwxinit parse: {e} (body: {init_text})"))?;
            eprintln!(
                "[wechat] webwxinit ok ret={:?} synckey_items={}",
                init_data.base_response.ret,
                init_data
                    .sync_key
                    .as_ref()
                    .map(|sk| sk.list.len())
                    .unwrap_or(0),
            );

            let synckey_str = init_data
                .sync_key
                .as_ref()
                .map(|sk| {
                    sk.list
                        .iter()
                        .map(|item| format!("{}_{}", item.key, item.val))
                        .collect::<Vec<_>>()
                        .join("|")
                })
                .unwrap_or_default();

            let nickname = init_data
                .user
                .as_ref()
                .and_then(|u| u.nick_name.clone())
                .unwrap_or_default();
            let avatar_url = init_data
                .user
                .as_ref()
                .and_then(|u| u.head_img_url.clone())
                .unwrap_or_default();
            let user_name = init_data
                .user
                .as_ref()
                .and_then(|u| u.user_name.clone())
                .unwrap_or_default();
            let account_id = wxuin.clone();

            {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                inner.skey = skey;
                inner.sid = wxsid;
                inner.uin = wxuin;
                inner.pass_ticket = pass_ticket;
                inner.synckey = synckey_str;
                inner.device_id = device_id;
                inner.nickname = nickname.clone();
                inner.avatar_url = avatar_url.clone();
                inner.user_name = user_name;
                inner.cookies = cookies;
                inner.sync_host = sync_host;
                inner.file_host = file_host;
                inner.logged_in = true;
            }
            // Save session to disk AFTER releasing the lock
            {
                let inner = state.inner.lock().map_err(|e| e.to_string())?;
                save_session(&app, &inner);
            }

            Ok(LoginStatus {
                status: "logged_in".to_string(),
                message: "登录成功".to_string(),
                nickname: Some(nickname),
                avatar_url: Some(avatar_url),
                wxid: Some(account_id),
                session_token: Some("filehelper_session".to_string()),
            })
        }
        "201" => {
            // Scanned — update tip for next poll AND persist accumulated cookies
            {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                inner.cookies = cookies;
                inner.cookies.insert("_qr_tip".to_string(), "0".to_string());
            }
            Ok(LoginStatus {
                status: "scanned".to_string(),
                message: "已扫描，请在手机上确认".to_string(),
                nickname: None,
                avatar_url: None,
                wxid: None,
                session_token: None,
            })
        }
        "408" => {
            // Persist cookies between polls so session cookies accumulate
            {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                inner.cookies = cookies;
            }
            Ok(LoginStatus {
                status: "waiting".to_string(),
                message: "等待扫描".to_string(),
                nickname: None,
                avatar_url: None,
                wxid: None,
                session_token: None,
            })
        }
        _ => {
            // On timeout/error, still persist any cookies we got
            {
                let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
                inner.cookies = cookies;
            }
            Ok(LoginStatus {
                status: "timeout".to_string(),
                message: format!("二维码已过期 (code={code})"),
                nickname: None,
                avatar_url: None,
                wxid: None,
                session_token: None,
            })
        }
    }
}

#[tauri::command]
pub fn wechat_get_user_info(
    state: tauri::State<'_, WechatFilehelperState>,
) -> Result<UserInfo, String> {
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(UserInfo {
        nickname: if inner.nickname.is_empty() {
            "WeChat User".to_string()
        } else {
            inner.nickname.clone()
        },
        avatar_url: inner.avatar_url.clone(),
        wxid: inner.uin.clone(),
    })
}

#[tauri::command]
pub async fn wechat_sync_messages(
    state: tauri::State<'_, WechatFilehelperState>,
) -> Result<SyncResponse, String> {
    let (skey, sid, uin, synckey, sync_host, device_id, pass_ticket, cookies) = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        if !inner.logged_in {
            return Err("未登录".to_string());
        }
        (
            inner.skey.clone(),
            inner.sid.clone(),
            inner.uin.clone(),
            inner.synckey.clone(),
            inner.sync_host.clone(),
            inner.device_id.clone(),
            inner.pass_ticket.clone(),
            inner.cookies.clone(),
        )
    };

    // Step 1: synccheck
    let synccheck_url = format!(
        "https://{sync_host}/cgi-bin/mmwebwx-bin/synccheck?r={r}&skey={skey}&sid={sid}&uin={uin}&deviceid={device_id}&synckey={synckey}&mmweb_appid=wx_webfilehelper&_={ts}",
        sync_host = sync_host,
        r = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
        skey = url_encode(&skey),
        sid = url_encode(&sid),
        uin = uin,
        device_id = url_encode(&device_id),
        synckey = url_encode(&synckey),
        ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    );

    let check_resp = http_get_raw(&synccheck_url, &cookies)?;
    let check_body = check_resp
        .into_string()
        .map_err(|e| format!("synccheck read: {e}"))?;

    let retcode = extract_synccheck_val(&check_body, "retcode");
    let selector = extract_synccheck_val(&check_body, "selector");

    // retcode != "0" means logged out
    if retcode != "0" {
        {
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            inner.logged_in = false;
        }
        return Ok(SyncResponse {
            messages: vec![],
            sync_key: synckey,
            has_more: false,
            retcode: retcode.clone(),
            selector: selector.clone(),
        });
    }

    // selector != "0" means new messages (matches reference: "2"/"6"/"7" all indicate messages)
    if selector == "0" {
        return Ok(SyncResponse {
            messages: vec![],
            sync_key: synckey,
            has_more: false,
            retcode,
            selector,
        });
    }

    // Step 2: webwxsync — fetch messages
    let sync_url = format!(
        "https://{sync_host}/cgi-bin/mmwebwx-bin/webwxsync?sid={sid}&skey={skey}&pass_ticket={pt}&mmweb_appid=wx_webfilehelper",
        sync_host = sync_host,
        sid = url_encode(&sid),
        skey = url_encode(&skey),
        pt = &pass_ticket,
    );

    let sync_body = serde_json::json!({
        "BaseRequest": {
            "Uin": uin.parse::<i64>().unwrap_or(0),
            "Sid": &sid,
            "Skey": &skey,
            "DeviceID": &device_id,
        },
        "SyncKey": {
            "List": parse_synckey_to_list(&synckey),
            "Count": parse_synckey_to_list(&synckey).len(),
        },
        "rr": !((std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()) as i64),
    });

    let sync_resp = http_post_json(&sync_url, &cookies, sync_body)?;
    let sync_text = sync_resp
        .into_string()
        .map_err(|e| format!("webwxsync read: {e}"))?;
    let sync_data: WebwxSyncResponse = serde_json::from_str(&sync_text)
        .map_err(|e| format!("webwxsync parse: {e} (body: {})", sync_text))?;

    let new_synckey = sync_data
        .sync_key
        .as_ref()
        .map(|sk| {
            sk.list
                .iter()
                .map(|item| format!("{}_{}", item.key, item.val))
                .collect::<Vec<_>>()
                .join("|")
        })
        .unwrap_or(synckey.clone());

    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.synckey = new_synckey.clone();
    }

    let messages: Vec<WechatMessage> = sync_data
        .add_msg_list
        .unwrap_or_default()
        .into_iter()
        .filter_map(convert_webwx_message)
        .collect();
    let add_count = sync_data.add_msg_count.unwrap_or(0);

    Ok(SyncResponse {
        has_more: add_count > 0 && messages.is_empty(),
        messages,
        sync_key: new_synckey,
        retcode,
        selector,
    })
}

#[tauri::command]
pub async fn wechat_download_attachment(
    state: tauri::State<'_, WechatFilehelperState>,
    cdn_info: String,
    is_image: Option<bool>,
    image_aeskey: Option<String>, // kept for API compat, unused in web filehelper
) -> Result<Vec<u8>, String> {
    let _ = image_aeskey; // unused — web filehelper doesn't need AES

    let (skey, sid, uin, pass_ticket, sync_host, file_host, cookies) = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        if !inner.logged_in {
            return Err("未登录".to_string());
        }
        (
            inner.skey.clone(),
            inner.sid.clone(),
            inner.uin.clone(),
            inner.pass_ticket.clone(),
            inner.sync_host.clone(),
            inner.file_host.clone(),
            inner.cookies.clone(),
        )
    };

    // cdn_info is JSON: { msgId, mediaId?, encryFileName?, fileName?, fromUser?, url? }
    #[derive(Deserialize)]
    struct DownloadInfo {
        #[serde(rename = "msgId")]
        msg_id: Option<String>,
        #[serde(rename = "mediaId")]
        media_id: Option<String>,
        #[serde(rename = "encryFileName")]
        encry_file_name: Option<String>,
        #[serde(rename = "fileName")]
        file_name: Option<String>,
        #[serde(rename = "fromUser")]
        from_user: Option<String>,
        #[serde(rename = "imageUrl")]
        image_url: Option<String>,
        #[serde(rename = "rawContent")]
        raw_content: Option<String>,
        #[allow(dead_code)]
        url: Option<String>,
    }

    let info: DownloadInfo = serde_json::from_str(&cdn_info).unwrap_or(DownloadInfo {
        msg_id: Some(cdn_info.clone()),
        media_id: None,
        encry_file_name: None,
        file_name: None,
        from_user: None,
        image_url: None,
        raw_content: None,
        url: None,
    });

    let download_urls = if is_image.unwrap_or(false) {
        let mut urls = Vec::new();
        if let Some(msg_id) = info.msg_id.as_deref().filter(|s| !s.is_empty()) {
            for kind in ["big", "slave"] {
                urls.push((
                    format!("webwxgetmsgimg:{kind}"),
                    format!(
                        "https://{sync_host}/cgi-bin/mmwebwx-bin/webwxgetmsgimg?MsgID={msg_id}&skey={skey}&type={kind}&mmweb_appid=wx_webfilehelper&_={ts}",
                        sync_host = sync_host,
                        msg_id = msg_id,
                        skey = url_encode(&skey),
                        kind = kind,
                        ts = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_millis(),
                    ),
                ));
            }
        }

        if let Some(url) = info
            .image_url
            .as_deref()
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        {
            urls.push(("direct:imageUrl".to_string(), url.to_string()));
        } else if let Some(url) = info
            .url
            .as_deref()
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        {
            urls.push(("direct:url".to_string(), url.to_string()));
        } else if let Some(raw) = info.raw_content.as_deref() {
            let sender = info.from_user.as_deref().unwrap_or("");
            let ticket = cookies
                .get("webwx_data_ticket")
                .cloned()
                .unwrap_or_default();
            for attr in ["cdnthumburl", "cdnmidimgurl", "cdnbigimgurl"] {
                let media_id = extract_xml_attr(raw, attr);
                if media_id.is_empty() {
                    continue;
                }
                urls.push((
                    format!("webwxgetmedia:{attr}"),
                    format!(
                        "https://{file_host}/cgi-bin/mmwebwx-bin/webwxgetmedia?sender={sender}&mediaid={media_id}&encryfilename=&fromuser={from_user}&pass_ticket={pt}&webwx_data_ticket={ticket}&sid={sid}&mmweb_appid=wx_webfilehelper&filename=image.jpg",
                        file_host = file_host,
                        sender = url_encode(sender),
                        from_user = url_encode(&uin),
                        media_id = url_encode(&media_id),
                        pt = url_encode(&pass_ticket),
                        ticket = url_encode(&ticket),
                        sid = url_encode(&sid),
                    ),
                ));
            }
        }
        if urls.is_empty() {
            return Err("Missing image download information".to_string());
        }
        urls
    } else {
        let sender = info.from_user.as_deref().unwrap_or("");
        let media_id = info.media_id.as_deref().unwrap_or("");
        let encry_name = info.encry_file_name.as_deref().unwrap_or("");
        let _file_name = info.file_name.as_deref().unwrap_or("");
        let raw_content = info.raw_content.as_deref().unwrap_or("");
        let ticket = cookies
            .get("webwx_data_ticket")
            .cloned()
            .unwrap_or_default();
        let attach_info = extract_file_attach_info(raw_content);
        // Try multiple URL patterns for file download: CDN first, then webwxgetmedia fallbacks.
        let mut urls: Vec<(String, String)> = Vec::new();
        let file_hosts = candidate_file_hosts(&file_host);

        // Pattern 0: CDN direct URL from cdnattachurl in raw XML.
        // In many Web WeChat file messages cdnattachurl is an XML tag, not an
        // attribute, and can also be an opaque media id rather than a full URL.
        if attach_info.cdn_attach_url.starts_with("http://")
            || attach_info.cdn_attach_url.starts_with("https://")
        {
            urls.push((
                "cdnattachurl".to_string(),
                attach_info.cdn_attach_url.clone(),
            ));
            eprintln!(
                "[wechat] file download using CDN URL: {}",
                attach_info.cdn_attach_url
            );
        }

        let mut media_ids = Vec::new();
        push_unique(&mut media_ids, media_id);
        if !(attach_info.cdn_attach_url.starts_with("http://")
            || attach_info.cdn_attach_url.starts_with("https://"))
        {
            push_unique(&mut media_ids, &attach_info.cdn_attach_url);
        }
        push_unique(&mut media_ids, &attach_info.attach_id);
        push_unique(&mut media_ids, &attach_info.svr_id);

        let mut encry_names = vec![String::new()];
        push_unique(&mut encry_names, encry_name);
        push_unique(&mut encry_names, &attach_info.aes_key);

        for media in media_ids {
            for enc in &encry_names {
                let enc_label = if enc.is_empty() { "noenc" } else { "enc" };
                urls.push((
                    format!("webwxgetmedia:sync:{enc_label}"),
                    format!(
                        "https://{sync_host}/cgi-bin/mmwebwx-bin/webwxgetmedia?sender={sender}&mediaid={media_id}&encryfilename={encry_name}&fromuser={from_user}&pass_ticket={pt}&webwx_data_ticket={ticket}&sid={sid}&mmweb_appid=wx_webfilehelper&filename={fname}",
                        sync_host = sync_host,
                        sender = url_encode(sender),
                        from_user = url_encode(&uin),
                        media_id = url_encode(&media),
                        encry_name = url_encode(enc),
                        pt = url_encode(&pass_ticket),
                        ticket = url_encode(&ticket),
                        sid = url_encode(&sid),
                        fname = url_encode(_file_name),
                    ),
                ));
                for host in &file_hosts {
                    urls.push((
                        format!("webwxgetmedia:{host}:{enc_label}"),
                        format!(
                            "https://{file_host}/cgi-bin/mmwebwx-bin/webwxgetmedia?sender={sender}&mediaid={media_id}&encryfilename={encry_name}&fromuser={from_user}&pass_ticket={pt}&webwx_data_ticket={ticket}&sid={sid}&mmweb_appid=wx_webfilehelper&filename={fname}",
                            file_host = host,
                            sender = url_encode(sender),
                            from_user = url_encode(&uin),
                            media_id = url_encode(&media),
                            encry_name = url_encode(enc),
                            pt = url_encode(&pass_ticket),
                            ticket = url_encode(&ticket),
                            sid = url_encode(&sid),
                            fname = url_encode(_file_name),
                        ),
                    ));
                }
            }
        }

        if urls.is_empty() {
            return Err("Missing file download information".to_string());
        }
        urls
    };

    let mut last_error = String::new();
    for (label, download_url) in download_urls {
        let resp = http_get_download(&download_url, &cookies);
        let resp = match resp {
            Ok(resp) => resp,
            Err(err) => {
                eprintln!("[wechat] download {label} failed: {err}");
                last_error = err;
                continue;
            }
        };
        let status = resp.status();
        let content_type = resp.header("content-type").unwrap_or("").to_string();
        let mut data = Vec::new();
        resp.into_reader()
            .read_to_end(&mut data)
            .map_err(|e| format!("读取下载数据失败: {e}"))?;
        let is_html = content_type.starts_with("text/html")
            || (data.len() >= 15 && &data[..15] == b"<!DOCTYPE html>")
            || (data.len() >= 5 && &data[..5] == b"<html");
        let first_bytes = String::from_utf8_lossy(&data[..data.len().min(100)]);
        eprintln!(
            "[wechat] download {label} status={status} content_type={content_type} bytes={} is_html={is_html} first={first_bytes}",
            data.len(),
        );
        if !data.is_empty() && !is_html {
            return Ok(data);
        }
        if is_html {
            last_error = format!("{label} returned HTML page (likely error/auth)");
        } else {
            last_error = format!("{label} returned empty body");
        }
    }

    Err(last_error)
}

#[tauri::command]
pub fn wechat_resolve_file_transfer(
    _state: tauri::State<'_, WechatFilehelperState>,
) -> Result<String, String> {
    Ok("filehelper".to_string())
}

#[tauri::command]
pub fn wechat_filehelper_disconnect(
    app: tauri::AppHandle,
    state: tauri::State<'_, WechatFilehelperState>,
) -> Result<(), String> {
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    inner.logged_in = false;
    inner.skey.clear();
    inner.sid.clear();
    inner.uin.clear();
    inner.pass_ticket.clear();
    inner.synckey.clear();
    inner.cookies.clear();
    // Remove persisted session
    let path = session_path(&app);
    let _ = std::fs::remove_file(&path);
    Ok(())
}

// ── Session Persistence ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct SessionData {
    skey: String,
    sid: String,
    uin: String,
    pass_ticket: String,
    synckey: String,
    device_id: String,
    nickname: String,
    avatar_url: String,
    user_name: String,
    cookies: HashMap<String, String>,
    sync_host: String,
    file_host: String,
}

fn session_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("wechat_session.json")
}

fn save_session(app: &tauri::AppHandle, inner: &WechatFilehelperInner) {
    let data = SessionData {
        skey: inner.skey.clone(),
        sid: inner.sid.clone(),
        uin: inner.uin.clone(),
        pass_ticket: inner.pass_ticket.clone(),
        synckey: inner.synckey.clone(),
        device_id: inner.device_id.clone(),
        nickname: inner.nickname.clone(),
        avatar_url: inner.avatar_url.clone(),
        user_name: inner.user_name.clone(),
        cookies: inner.cookies.clone(),
        sync_host: inner.sync_host.clone(),
        file_host: inner.file_host.clone(),
    };
    let path = session_path(app);
    if let Ok(json) = serde_json::to_string(&data) {
        let _ = std::fs::write(&path, json);
        eprintln!("[wechat] session saved to {:?}", path);
    }
}

fn load_session(app: &tauri::AppHandle) -> Option<SessionData> {
    let path = session_path(app);
    let json = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

#[tauri::command]
pub async fn wechat_try_restore_session(
    app: tauri::AppHandle,
    state: tauri::State<'_, WechatFilehelperState>,
) -> Result<LoginStatus, String> {
    let data = match load_session(&app) {
        Some(d) => d,
        None => {
            return Ok(LoginStatus {
                status: "idle".to_string(),
                message: "没有保存的会话".to_string(),
                nickname: None,
                avatar_url: None,
                wxid: None,
                session_token: None,
            })
        }
    };

    // Do a quick synccheck to verify the session is still valid
    let synccheck_url = format!(
        "https://{sync_host}/cgi-bin/mmwebwx-bin/synccheck?r={r}&skey={skey}&sid={sid}&uin={uin}&deviceid={device_id}&synckey={synckey}&mmweb_appid=wx_webfilehelper&_={ts}",
        sync_host = data.sync_host,
        r = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
        skey = url_encode(&data.skey),
        sid = url_encode(&data.sid),
        uin = url_encode(&data.uin),
        device_id = url_encode(&data.device_id),
        synckey = url_encode(&data.synckey),
        ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    );

    let resp = http_get_raw(&synccheck_url, &data.cookies)?;
    let body = resp
        .into_string()
        .map_err(|e| format!("synccheck read: {e}"))?;

    eprintln!("[wechat] restore synccheck: {body}");

    if body.contains("window.synccheck={retcode:\"0\"") {
        // Session valid — restore to state
        {
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            inner.skey = data.skey.clone();
            inner.sid = data.sid.clone();
            inner.uin = data.uin.clone();
            inner.pass_ticket = data.pass_ticket.clone();
            inner.synckey = data.synckey.clone();
            inner.device_id = data.device_id.clone();
            inner.nickname = data.nickname.clone();
            inner.avatar_url = data.avatar_url.clone();
            inner.user_name = data.user_name.clone();
            inner.cookies = data.cookies.clone();
            inner.sync_host = data.sync_host.clone();
            inner.file_host = data.file_host.clone();
            inner.logged_in = true;
        }

        Ok(LoginStatus {
            status: "logged_in".to_string(),
            message: "会话已恢复".to_string(),
            nickname: Some(data.nickname),
            avatar_url: Some(data.avatar_url),
            wxid: Some(data.uin),
            session_token: Some("filehelper_session".to_string()),
        })
    } else {
        // Session expired — clean up
        let _ = std::fs::remove_file(&session_path(&app));
        Ok(LoginStatus {
            status: "idle".to_string(),
            message: "会话已过期".to_string(),
            nickname: None,
            avatar_url: None,
            wxid: None,
            session_token: None,
        })
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn resolve_file_host(redirect_host: &str) -> String {
    match redirect_host {
        "szfilehelper.weixin.qq.com" | "filehelper.weixin.qq.com" => "file.wx2.qq.com".to_string(),
        h if h.contains("wx2.qq.com") => h.replace("webpush", "file").replace("web.", "file."),
        _ => redirect_host.to_string(),
    }
}

fn extract_synccheck_val(body: &str, key: &str) -> String {
    // Handle both "key:\"value\"" (JSON-style) and "key=\"value\"" formats
    let patterns = [format!("{key}:\""), format!("{key}=\"")];
    for pattern in &patterns {
        if let Some(i) = body.find(pattern as &str) {
            let start = i + pattern.len();
            if let Some(j) = body[start..].find('"') {
                return body[start..start + j].to_string();
            }
        }
    }
    "0".to_string()
}

fn parse_synckey_to_list(synckey: &str) -> Vec<WebwxSyncKeyItem> {
    synckey
        .split('|')
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '_');
            let key = parts.next()?.parse().ok()?;
            let val = parts.next()?.parse().ok()?;
            Some(WebwxSyncKeyItem { key, val })
        })
        .collect()
}

fn convert_webwx_message(msg: WebwxMessage) -> Option<WechatMessage> {
    let msg_type = msg.msg_type.unwrap_or(0);
    let from_user = msg.from_user_name.unwrap_or_default();
    let to_user = msg.to_user_name.unwrap_or_default();
    let create_time = msg.create_time.unwrap_or(0);
    let msg_id = msg
        .msg_id
        .clone()
        .unwrap_or_else(|| format!("{create_time}"));

    match msg_type {
        1 => {
            // Text
            Some(WechatMessage {
                msg_id,
                msg_type: 1,
                from_user,
                to_user,
                content: msg.content.unwrap_or_default(),
                create_time,
                card: None,
            })
        }
        3 => {
            // Image — pack download info as JSON
            let media_id = msg.media_id.unwrap_or_default();
            let raw_content = msg.content.unwrap_or_default();
            let image_data_base64 = msg.img_buf.and_then(|buf| buf.buffer).unwrap_or_default();
            let image_url = first_direct_image_url(&raw_content);
            eprintln!(
                "[wechat] image msg {} media_id_len={} imgbuf_len={} image_url={} raw_prefix={}",
                msg_id,
                media_id.len(),
                image_data_base64.len(),
                if image_url.is_empty() {
                    "(none)"
                } else {
                    &image_url
                },
                raw_content.chars().take(400).collect::<String>(),
            );
            let content = serde_json::json!({
                "msgId": msg_id,
                "mediaId": media_id,
                "fromUser": from_user.clone(),
                "toUser": to_user.clone(),
                "imageDataBase64": image_data_base64,
                "imageUrl": image_url,
                "rawContent": raw_content,
            })
            .to_string();
            Some(WechatMessage {
                msg_id,
                msg_type: 3,
                from_user,
                to_user,
                content,
                create_time,
                card: None,
            })
        }
        49 => {
            // App message — could be file (AppMsgType=6), link (AppMsgType=5), or other
            let app_msg_type = msg.app_msg_type.unwrap_or(0);
            let content = msg.content.unwrap_or_default();

            if app_msg_type == 6 {
                // File attachment
                let download_info = serde_json::json!({
                    "msgId": msg_id,
                    "mediaId": msg.media_id.unwrap_or_default(),
                    "encryFileName": msg.encry_file_name.unwrap_or_default(),
                    "fileName": msg.file_name.unwrap_or_default(),
                    "fileSize": msg.file_size.unwrap_or_default(),
                    "fromUser": from_user,
                    "rawContent": content,
                })
                .to_string();
                Some(WechatMessage {
                    msg_id,
                    msg_type: 49,
                    from_user,
                    to_user,
                    content: download_info,
                    create_time,
                    card: None,
                })
            } else if app_msg_type == 5 || !content.is_empty() {
                // Link or other app message — parse card info from XML
                let card = parse_appmsg_card(&content);
                Some(WechatMessage {
                    msg_id,
                    msg_type: 49,
                    from_user,
                    to_user,
                    content,
                    create_time,
                    card,
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

// ── URL Fetch ────────────────────────────────────────────────────────────────
//
// Fetches a URL with multi-layer auth fallback:
//   1. Try with WeChat cookies + mobile UA (for WeChat public account links)
//   2. If that fails with auth-related error, try with desktop UA (no cookies)
//   3. If HTTPS fails, retry with HTTP

#[derive(Serialize)]
pub struct FetchedUrl {
    pub title: String,
    pub html: String,
    pub final_url: String,
}

#[tauri::command]
pub async fn fetch_url_content(
    url: String,
    state: tauri::State<'_, WechatFilehelperState>,
) -> Result<FetchedUrl, String> {
    let cookies = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner.cookies.clone()
    };

    // Build WeChat cookie header if we have session cookies
    let wechat_cookie = if !cookies.is_empty() {
        cookies
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("; ")
    } else {
        String::new()
    };

    let mobile_ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.38";
    let desktop_ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    let candidates = build_link_candidates(&url);
    let mut errors = Vec::new();

    for candidate in candidates {
        // Strategy 1: WeChat cookies + mobile UA (for authenticated WeChat links)
        if !wechat_cookie.is_empty() {
            match fetch_with_ua_and_cookies(&candidate, mobile_ua, &wechat_cookie) {
                Ok(resp) => return Ok(resp),
                Err(err) => errors.push(err),
            }
        }

        // Strategy 2: WeChat cookies + desktop UA. Some WeChat links reject
        // MicroMessenger UA after a desktop redirect but still accept cookies.
        if !wechat_cookie.is_empty() {
            match fetch_with_ua_and_cookies(&candidate, desktop_ua, &wechat_cookie) {
                Ok(resp) => return Ok(resp),
                Err(err) => errors.push(err),
            }
        }

        // Strategy 3: Mobile UA without cookies for public pages.
        match fetch_with_ua_and_cookies(&candidate, mobile_ua, "") {
            Ok(resp) => return Ok(resp),
            Err(err) => errors.push(err),
        }

        // Strategy 4: Desktop UA, no cookies.
        match fetch_with_ua_and_cookies(&candidate, desktop_ua, "") {
            Ok(resp) => return Ok(resp),
            Err(err) => errors.push(err),
        }
    }

    let last_error = errors.last().cloned().unwrap_or_default();
    Err(format!(
        "Failed to fetch URL with all auth/user-agent strategies: {url}; last error: {last_error}"
    ))
}

fn build_link_candidates(url: &str) -> Vec<String> {
    let decoded = decode_html_entities(url.trim());
    let mut candidates = vec![decoded.clone()];
    if decoded.contains("mp.weixin.qq.com/") && !decoded.contains("nwr_flag=") {
        candidates.push(add_query_param_before_fragment(&decoded, "nwr_flag=1"));
    }

    if decoded.starts_with("http://mp.weixin.qq.com/") {
        candidates.push(decoded.replacen("http://", "https://", 1));
    }

    if decoded.starts_with("https://") {
        candidates.push(decoded.replacen("https://", "http://", 1));
    }

    let mut unique = Vec::new();
    for candidate in candidates {
        if !unique.contains(&candidate) {
            unique.push(candidate);
        }
    }
    unique
}

fn decode_html_entities(text: &str) -> String {
    let mut decoded = text.trim().to_string();
    for _ in 0..5 {
        let next = decoded
            .replace("&amp;", "&")
            .replace("&#38;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'");
        if next == decoded {
            break;
        }
        decoded = next;
    }
    decoded.trim_end_matches("</url>").trim().to_string()
}

fn add_query_param_before_fragment(url: &str, param: &str) -> String {
    let (base, fragment) = url
        .split_once('#')
        .map(|(base, fragment)| (base, Some(fragment)))
        .unwrap_or((url, None));
    let sep = if base.contains('?') { "&" } else { "?" };
    match fragment {
        Some(fragment) => format!("{base}{sep}{param}#{fragment}"),
        None => format!("{base}{sep}{param}"),
    }
}

fn fetch_with_ua_and_cookies(
    url: &str,
    user_agent: &str,
    cookie: &str,
) -> Result<FetchedUrl, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(10))
        .timeout_read(std::time::Duration::from_secs(30))
        .build();

    let mut req = agent
        .get(url)
        .set("User-Agent", user_agent)
        .set(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");

    if !cookie.is_empty() {
        req = req.set("Cookie", cookie);
    }

    // Set Referer for WeChat links
    if url.contains("mp.weixin.qq.com") || url.contains("weixin") {
        req = req.set("Referer", "https://mp.weixin.qq.com/");
    }

    let resp = req.call().map_err(|e| format!("HTTP fetch failed: {e}"))?;

    let final_url = resp.get_url().to_string();
    let html = resp
        .into_string()
        .map_err(|e| format!("Failed to read body: {e}"))?;

    if is_access_blocked_html(&html, &final_url) {
        return Err(format!("Access wall detected at {final_url}"));
    }

    let title = extract_article_title(&html);

    Ok(FetchedUrl {
        title,
        html,
        final_url,
    })
}

fn extract_article_title(html: &str) -> String {
    extract_meta_content(html, "og:title")
        .or_else(|| extract_meta_content(html, "twitter:title"))
        .or_else(|| extract_js_string_var(html, "msg_title"))
        .or_else(|| extract_js_string_var(html, "title"))
        .or_else(|| {
            html.find("<title>").and_then(|i| {
                let after = &html[i + 7..];
                after
                    .find("</title>")
                    .map(|j| html_decode_basic(after[..j].trim()))
                    .filter(|title| !title.is_empty() && title != "微信公众平台")
            })
        })
        .unwrap_or_default()
}

fn extract_meta_content(html: &str, property: &str) -> Option<String> {
    let marker = format!("property=\"{property}\"");
    let start = html.find(&marker)?;
    let tag_start = html[..start].rfind('<').unwrap_or(start);
    let tag_end = html[start..].find('>').map(|i| start + i)?;
    let tag = &html[tag_start..=tag_end];
    extract_attr(tag, "content")
        .map(|value| html_decode_basic(value.trim()))
        .filter(|value| !value.is_empty())
}

fn extract_attr<'a>(tag: &'a str, attr: &str) -> Option<&'a str> {
    let marker = format!("{attr}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = tag[start..].find('"')?;
    Some(&tag[start..start + end])
}

fn extract_js_string_var(html: &str, name: &str) -> Option<String> {
    let marker = format!("var {name} = ");
    let start = html.find(&marker)? + marker.len();
    let rest = html[start..].trim_start();
    let quote = rest.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let end = rest[1..].find(quote)? + 1;
    Some(html_decode_basic(&rest[1..end]))
        .filter(|value| !value.is_empty() && value != "微信公众平台")
}

fn html_decode_basic(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&#38;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn is_access_blocked_html(html: &str, final_url: &str) -> bool {
    let lower_url = final_url.to_ascii_lowercase();
    let lower_html = html.to_ascii_lowercase();

    lower_url.contains("/login")
        || lower_url.contains("auth")
        || lower_html.contains("forbidden")
        || lower_html.contains("access denied")
        || (html.len() < 1000 && (lower_html.contains("login") || lower_html.contains("auth")))
        || html.contains("请在微信客户端打开链接")
        || html.contains("环境异常")
        || html.contains("访问受限")
        || html.contains("该内容已被发布者删除")
        || html.contains("此内容无法查看")
        || (html.len() < 200 && (html.contains("验证") || html.contains("权限")))
}

// ── Send Message ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn wechat_send_message(
    state: tauri::State<'_, WechatFilehelperState>,
    content: String,
) -> Result<(), String> {
    // Clone all needed data and release lock BEFORE HTTP request
    let (url, body, cookies) = {
        let inner = state.inner.lock().map_err(|e| e.to_string())?;
        if !inner.logged_in {
            return Err("Not logged in".to_string());
        }

        let url = format!(
            "https://{}/cgi-bin/mmwebwx-bin/webwxsendmsg?lang=zh_CN&pass_ticket={}",
            inner.sync_host,
            url_encode(&inner.pass_ticket),
        );

        let client_msg_id = format!(
            "{}{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis(),
            rand::thread_rng().gen_range(1000..9999u64)
        );

        let body = serde_json::json!({
            "BaseRequest": {
                "Uin": inner.uin.parse::<i64>().unwrap_or(0),
                "Sid": &inner.sid,
                "Skey": &inner.skey,
                "DeviceID": &inner.device_id,
            },
            "Msg": {
                "Type": 1,
                "Content": content,
                "FromUserName": &inner.user_name,
                "ToUserName": "filehelper",
                "LocalID": &client_msg_id,
                "ClientMsgId": &client_msg_id,
            },
            "Scene": 0,
        });

        (url, body, inner.cookies.clone())
    };

    let resp = http_post_json(&url, &cookies, body)?;
    let resp_text = resp.into_string().unwrap_or_default();

    // Check for send success
    if resp_text.contains("\"Ret\": 0") || resp_text.contains("\"Ret\":0") {
        Ok(())
    } else {
        Err(format!("Send failed: {resp_text}"))
    }
}
