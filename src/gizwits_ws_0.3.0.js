// commType = 'custom' | 'attrs_v4'
// socketType = 'socket' | 'ssl_socket'
function GizwitsWS(apiHost, wechatOpenId, gizwitsAppId, commType, socketType) {
  this.onInit = undefined;
  this.onConnected = undefined;
  this.onOnlineStatusChanged = undefined;
  this.onReceivedRaw = undefined;
  this.onReceivedAttrs = undefined;
  this.onError = undefined;

  this._openId = wechatOpenId;
  this._appId = gizwitsAppId;
  this._commType = commType;
  if (socketType == undefined) {
    this._socketType = "ssl_socket";
  } else {
    this._socketType = socketType;
  }
  this._apiHost = apiHost;
  this._connections = {};
  this._userId = undefined;
  this._userToken = undefined;
  this._bindingDevices = undefined;

  this._heartbeatInterval = 60;
  this._keepaliveTime = 180;
  this._autoSubscribe = false;
}

function Connection(wsInfo, callback) {
  this._wsUrl = "{0}/ws/app/v1".format(wsInfo);
  this._websocket = undefined;
  this._heartbeatTimerId = undefined;
  this._loginFailedTimes = 0;
  this._subDids = [];
  this._callbackObj = callback;
}

//=========================================================
// api functions
//=========================================================
GizwitsWS.prototype.init = function() {
  var me = this;
  me._getUserToken();
};

GizwitsWS.prototype.connect = function(did) {
  var me = this;
  if (me._bindingDevices == undefined) {
    me._sendError("Please call 'init()' firstly.");
    return;
  }

  var device = me._bindingDevices[did];
  if (device == null) {
    me._sendError("Device is not bound.");
    return;
  }

  var wsInfo = me._getWebsocketConnInfo(device);
  var conn = me._connections[wsInfo];
  if (conn == null) {
    conn = new Connection(wsInfo, me);
  }
  conn._addSubDid(did);
  if (conn._websocket == null || conn._websocket.readyState != conn._websocket.OPEN) {
    conn._connectWS();
    me._connections[wsInfo] = conn;
  } else {
    conn._subDevices([did]);
  }
};

GizwitsWS.prototype.send = function(did, data) {
  var me = this;
  if (me._bindingDevices == undefined) {
    me._sendError("Please call 'init()' firstly.");
    return;
  }

  var device = me._bindingDevices[did];
  if (device == null) {
    me._sendError("Device is not bound.");
    return;
  }

  var wsInfo = me._getWebsocketConnInfo(device);
  var conn = me._connections[wsInfo];
  if (conn == null) {
    me._sendError("Websocket is not connected.");
    return;
  }

  conn._sendJson({
    cmd: "c2s_raw",
    data: {
      did: did,
      raw: data
    }
  });
};

GizwitsWS.prototype.read = function(did, names) {
  var me = this;
  if (me._bindingDevices == undefined) {
    me._sendError("Please call 'init()' firstly.");
    return;
  }

  var device = me._bindingDevices[did];
  if (device == null) {
    me._sendError("Device is not bound.");
    return;
  }

  var wsInfo = me._getWebsocketConnInfo(device);
  var conn = me._connections[wsInfo];
  if (conn == null) {
    me._sendError("Websocket is not connected.");
    return;
  }

  if (names == null) {
    conn._sendJson({
      cmd: "c2s_read",
      data: {
        did: did
      }
    });
    return;
  }
  conn._sendJson({
    cmd: "c2s_read",
    data: {
      did: did,
      names: names
    }
  });
};

GizwitsWS.prototype.write = function(did, attrs) {
  var me = this;
  if (me._bindingDevices == undefined) {
    me._sendError("Please call 'init()' firstly.");
    return;
  }

  var device = me._bindingDevices[did];
  if (device == null) {
    me._sendError("Device is not bound.");
    return;
  }

  var wsInfo = me._getWebsocketConnInfo(device);
  var conn = me._connections[wsInfo];
  if (conn == null) {
    me._sendError("Websocket is not connected.");
    return;
  }

  conn._sendJson({
    cmd: "c2s_write",
    data: {
      did: did,
      attrs: attrs
    }
  });
};

// for qa function
GizwitsWS.prototype.setLoginParams = function(heartbeatTime, keepalive, autoSubscribe) {
  var me = this;
  me._heartbeatInterval = heartbeatTime;
  me._keepaliveTime = keepalive;
  me._autoSubscribe = autoSubscribe;
  window.alert("Success!");
};

//=========================================================
// http functions
//=========================================================
GizwitsWS.prototype._getUserToken = function() {
  var me = this;
  var url = "https://{0}/app/users".format(me._apiHost);
  $.ajax(url, {
      type: "POST",
      contentType: "application/json",
      headers: { "X-Gizwits-Application-Id": me._appId },
      dataType: "json",
      data: "{\"phone_id\":\"" + me._openId + "\",\"lang\":\"en\"}"
    })
    .done(function(result) {
      me._userId = result.uid;
      me._userToken = result.token;
      var limit = 20;
      var skip = 0;
      me._bindingDevices = {};
      me._getBindingList(limit, skip);
    })
    .fail(function(evt) {
      me._sendError("Init error when getting user token: " + evt.responseText);
    });
};

GizwitsWS.prototype._getBindingList = function(limit, skip) {
  var me = this;
  var url = "https://{0}/app/bindings".format(me._apiHost);
  var query = "?show_disabled=0&limit=" + limit + "&skip=" + skip;
  $.ajax(url + query, {
      type: "GET",
      contentType: "application/json",
      dataType: "json",
      headers: { "X-Gizwits-Application-Id": me._appId, "X-Gizwits-User-token": me._userToken }
    })
    .done(function(result) {
      for (var i in result.devices) {
        var device = result.devices[i];
        var did = device.did;
        me._bindingDevices[did] = device;
      }

      if (result.devices.length == limit) {
        me._getBindingList(limit, skip + limit);
      } else {
        me._returnDeviceList();
      }
    })
    .fail(function(evt) {
      me._bindingDevices = undefined;
      me._sendError("Init error when getting binding devices: " + evt.responseText);
    });
};

//=========================================================
// websocket functions
//=========================================================
Connection.prototype._connectWS = function() {
  var conn = this;

  var websocket = new WebSocket(conn._wsUrl);
  websocket.onopen = function(evt) { conn._onWSOpen(evt) };
  websocket.onclose = function(evt) { conn._onWSClose(evt) };
  websocket.onmessage = function(evt) { conn._onWSMessage(evt) };
  websocket.onerror = function(evt) { conn._onWSError(evt) };

  conn._websocket = websocket;
};

Connection.prototype._onWSOpen = function(evt) {
  var conn = this;
  conn._login();
};

Connection.prototype._onWSClose = function(evt) {
  var conn = this;
  conn._stopPing();
  conn._callbackObj._sendError("Websocket Connect failed, please try again after a moment.");
};

Connection.prototype._onWSMessage = function(evt) {
  var conn = this;
  var res = JSON.parse(evt.data);
  switch (res.cmd) {
    case "pong":
      break;
    case "login_res":
      if (res.data.success == true) {
        conn._loginFailedTimes = 0;
        conn._startPing();
        conn._subDevices(conn._subDids);
      } else {
        conn._callbackObj._sendError("Login failed, will try again, please wait...");
        conn._tryLoginAgain();
      }
      break;
    case "subscribe_res":
      var successDids = res.data.success;
      var failedDids = res.data.failed;
      for (var i = 0; i < successDids.length; i++) {
        if (conn._callbackObj.onConnected) {
          conn._callbackObj.onConnected(successDids[i].did);
        }
      }
      for (var j = 0; j < failedDids.length; j++) {
        conn._removeSubDid(failedDids[j].did);
        conn._callbackObj._sendError("Connect error with did: " + failedDids[j].did + ", please try again.");
      }
      break;
    case "s2c_online_status":
      var device = conn._callbackObj._getBindingDevice(res.data.did);
      if (conn._callbackObj.onOnlineStatusChanged && device) {
        conn._callbackObj.onOnlineStatusChanged({
          did: device.did,
          is_online: res.data.online
        });
      }
      break;
    case "s2c_raw":
      var device = conn._callbackObj._getBindingDevice(res.data.did);
      if (conn._callbackObj.onReceivedRaw && device) {
        conn._callbackObj.onReceivedRaw({
          did: device.did,
          raw: res.data.raw
        });
      }
      break;
    case "s2c_noti":
      var device = conn._callbackObj._getBindingDevice(res.data.did);
      if (conn._callbackObj.onReceivedAttrs && device) {
        conn._callbackObj.onReceivedAttrs({
          did: device.did,
          attrs: res.data.attrs
        });
      }
      break;
    case "s2c_invalid_msg":
      var errorCode = res.data.error_code;
      if (errorCode == 1009) {
        conn._tryLoginAgain();
      } else {
        conn._callbackObj._sendError("ErrorCode " + errorCode + ": " + res.data.msg);
      }
      break;
  }
};

Connection.prototype._onWSError = function(evt) {
  var conn = this;
  conn._callbackObj._sendError("Websocket on error");
};

Connection.prototype._startPing = function() {
  var conn = this;
  var heartbeatInterval = conn._callbackObj._heartbeatInterval * 1000;
  conn._heartbeatTimerId = window.setInterval(function() { conn._sendJson({ cmd: "ping" }) }, heartbeatInterval);
};

Connection.prototype._stopPing = function() {
  var conn = this;
  window.clearInterval(conn._heartbeatTimerId);
};

Connection.prototype._sendJson = function(json) {
  var conn = this;
  var data = JSON.stringify(json);
  var websocket = conn._websocket;
  if (websocket.readyState == websocket.OPEN) {
    websocket.send(data);
    return true;
  } else {
    console.log("Send data error, websocket is not connected.");
    return false;
  }
};

//=========================================================
// helper functions
//=========================================================
Connection.prototype._login = function() {
  var conn = this;
  var keepalive = conn._callbackObj._keepaliveTime;
  var autoSub = conn._callbackObj._autoSubscribe;
  var json = {
    cmd: "login_req",
    data: {
      appid: conn._callbackObj._appId,
      uid: conn._callbackObj._userId,
      token: conn._callbackObj._userToken,
      p0_type: conn._callbackObj._commType,
      heartbeat_interval: keepalive, // default 180s
      auto_subscribe: autoSub
    }
  };
  conn._sendJson(json);
};

Connection.prototype._tryLoginAgain = function() {
  var conn = this;
  conn._loginFailedTimes += 1;
  if (conn._loginFailedTimes > 3) {
    conn._websocket.close();
    return;
  }
  var waitTime = conn._loginFailedTimes * 5000;
  window.setTimeout(function() { conn._login() }, waitTime);
};

Connection.prototype._addSubDid = function(did) {
  var conn = this;
  var subDids = conn._subDids;
  var subFlag = false;
  for (var i = 0; i < subDids.length; i++) {
    if (subDids[i] == did) {
      subFlag = true;
      break;
    }
  }
  if (!subFlag) {
    subDids[subDids.length] = did;
  }
};

Connection.prototype._removeSubDid = function(did) {
  var conn = this;
  var subDids = conn._subDids;
  for (var i = 0; i < subDids.length; i++) {
    if (subDids[i] == did) {
      subDids.splice(i, 1);
      break;
    }
  }
};

Connection.prototype._subDevices = function(dids) {
  var len = dids.length;
  var conn = this;
  var autoSub = conn._callbackObj._autoSubscribe;
  if (autoSub) {
    for (var i = 0; i < len; i++) {
      conn._callbackObj.onConnected(dids[i])
    }
    return;
  }
  var reqData = [];
  for (var i = 0; i < len; i++) {
    reqData.push({ did: dids[i] });
  }
  var json = {
    cmd: "subscribe_req",
    data: reqData
  };
  conn._sendJson(json);
};

GizwitsWS.prototype._sendError = function(msg) {
  if (this.onError) {
    this.onError(msg);
  }
};

GizwitsWS.prototype._returnDeviceList = function() {
  var me = this;
  if (me.onInit) {
    var devices = [];
    var i = 0;
    for (var key in me._bindingDevices) {
      devices[i] = {
        "did": me._bindingDevices[key].did,
        "mac": me._bindingDevices[key].mac,
        "product_key": me._bindingDevices[key].product_key,
        "is_online": me._bindingDevices[key].is_online,
        "dev_alias": me._bindingDevices[key].dev_alias,
        "remark": me._bindingDevices[key].remark
      };
      i++;
    }
    me.onInit(devices);
  }
};

GizwitsWS.prototype._getBindingDevice = function(did) {
  var me = this;
  return me._bindingDevices[did];
};

GizwitsWS.prototype._getWebsocketConnInfo = function(device) {
  var me = this;
  var host = device.host;
  var pre = "ws://";
  var port = device.ws_port.toString();
  if (me._socketType == "ssl_socket") {
    pre = "wss://";
    port = device.wss_port.toString();
  }
  return pre + host + ":" + port;
};

String.prototype.format = function() {
  var args = arguments;
  return this.replace(/\{(\d+)\}/g,
    function(m, i) {
      return args[i];
    });
};