/*
 * This file is part of Xpra.
 * Copyright (C) 2021 Tijs van der Zwaan <tijzwa@vpo.nl>
 * Copyright (c) 2022 Antoine Martin <antoine@xpra.org>
 * Licensed under MPL 2.0, see:
 * http://www.mozilla.org/MPL/2.0/
 *
 */

/*
 * Worker for offscreen decoding and painting.
 * Requires Chrome 94+ or Android and a secure (SSL or localhost) context.
 */

importScripts("./lib/zlib.js");
importScripts("./lib/lz4.js");
importScripts("./lib/broadway/Decoder.js");
importScripts("./VideoDecoder.js");
importScripts("./ImageDecoder.js");
importScripts("./RgbHelpers.js");

// Array of offscreen canvases and decoders we have control over
const offscreen_canvas = new Map();


function decode_error(packet, start, error) {
    self.postMessage({'error': ""+error, 'packet' : packet, 'start' : start});
}

function decode_ok(packet, start) {
    self.postMessage({ 'draw': packet, 'start': start });
}

function paint_image(packet, start) {
    const wid = packet[1],
        x = packet[2],
        y = packet[3],
        width = packet[4],
        height = packet[5],
        coding = packet[6],
        data = packet[7];

    let ctx = offscreen_canvas.get(wid)["ctx"];
    if (coding == "bitmap") {
        // RGB is transformed to bitmap
        ctx.clearRect(x, y, width, height);
        ctx.drawImage(data, x, y, width, height);
    }
    else if (coding == "image" ) {
        // All others are transformed to VideoFrame
        ctx.clearRect(x, y, width, height);
        ctx.drawImage(data.image, x, y, width, height);
        data.image.close();
    }
	else {
		decode_error(packet, start, "unsupported encoding: "+coding);
	}
    // Replace the coding & drop data
    packet[6] = "offscreen-painted";
    packet[7] = null;
	decode_ok(packet, start);
}

function new_image_decoder() {
    const image_decoder = new XpraImageDecoder();
    image_decoder.on_frame_decoded = paint_image;
    image_decoder.on_frame_error = decode_error;
    return image_decoder;
}

function paint_video_frame(packet, start) {
    const wid = packet[1],
        x = packet[2],
        y = packet[3],
        w = packet[4],
        h = packet[5],
        coding = packet[6],
        data = packet[7];
    let options = packet[10].length > 10 ? packet[10] : {};

    let enc_width = w;
    let enc_height = h;
    const scaled_size = options["scaled_size"];
    if (scaled_size) {
        enc_width = scaled_size[0];
        enc_height = scaled_size[1];
    }

    let ctx = offscreen_canvas.get(wid)["ctx"];
    if (coding == "frame") {
        ctx.drawImage(data, x, y, enc_width, enc_height);
        data.close();
        packet[6] = "offscreen-painted";
        packet[7] = null;
		decode_ok(packet, start);
    }
    else if (coding == "throttle"){
        // Encoding throttle is used to slow down frame input
        // TODO: Real error handling
        const timeout = coding == "throttle" ? 500 : 0;
        setTimeout(() => {
            packet[6] = "offscreen-painted";
            packet[7] = null;
			decode_ok(packet, start);
        }, timeout);
    }
	else {
		decode_error(packet, start, "unsupported video encoding: "+coding);
	}
}

function new_video_decoder() {
    const video_decoder = new XpraVideoDecoder();
    video_decoder.on_frame_decoded = paint_video_frame;
    video_decoder.on_frame_error = decode_error;
    return video_decoder;
}

function add_decoders_for_window(wid, canvas) {
    // Canvas
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    offscreen_canvas.set(wid, {
        "c"      : canvas,
        "ctx"    : ctx,
        "image-decoder" : new_image_decoder(),
        "video-decoder" : new_video_decoder(),
        });
}

function paint_scroll(packet, start) {
    const wid = packet[1];
    const data = packet[7];
    const oc = offscreen_canvas.get(wid);
    const canvas = oc["c"];
    const ctx = oc["ctx"];
    for (let i = 0, j = data.length; i < j; ++i) {
        const scroll_data = data[i];
        const sx = scroll_data[0],
            sy = scroll_data[1],
            sw = scroll_data[2],
            sh = scroll_data[3],
            xdelta = scroll_data[4],
            ydelta = scroll_data[5];
        ctx.drawImage(canvas, sx, sy, sw, sh, sx + xdelta, sy + ydelta, sw, sh);
    }
    packet[6] = "offscreen-painted";
    packet[7] = null;
	decode_ok(packet, start);
}


function decode_draw_packet(packet, start) {
    const image_coding = ["rgb", "rgb32", "rgb24", "jpeg", "png", "webp"];
    const video_coding = ["h264"];
    const wid = packet[1];
    const coding = packet[6];
    //const packet_sequence = packet[8];
    const oc = offscreen_canvas.get(wid);
    send_error = (message) => {
        self.postMessage({'error': message, 'packet' : packet, 'start' : start});
    }
    if (!oc) {
        send_error("no offscreen context for window "+wid);
        return;
    }

    try {
	    if (coding == "scroll") {
			this.paint_scroll(packet, start);
	    }
	    else if (image_coding.includes(coding)) {
	        // Add to image queue
	        let decoder = oc["image-decoder"];
	        decoder.queue_frame(packet, start);
	    }
	    else if (video_coding.includes(coding)) {
	        // Add to video queue
	        let decoder = oc["video-decoder"];
	        if (!decoder.initialized) {
	            // Init with width and heigth of this packet.
	            // TODO: Use video max-size? It does not seem to matter.
	            decoder.init(packet[4], packet[5]);
	        }
	        decoder.queue_frame(packet, start);
	    }
	    else {
	        // We dont know, pass trough
	        self.postMessage({ 'draw': packet, 'start': start });
	    }
    }
    catch (e) {
        send_error(e);
    }
}

function close(wid) {
    close_video(wid);
    offscreen_canvas.delete(wid);
}
function close_video(wid) {
    const oc = offscreen_canvas.get(wid);
    if (oc) {
        const video_decoder = oc["video-decoder"];
        if (video_decoder) {
            video_decoder._close();
        }
    }
}


onmessage = function (e) {
    const data = e.data;
    switch (data.cmd) {
        case 'check':
            // We do not check. We are here because we support native decoding.
            // TODO: Reconsider this. It might be a good thing to do some testing, just for sanity??
            const encodings = data.encodings;
            self.postMessage({ 'result': true, 'formats': encodings });
            break;
        case 'eos':
            close_video(data.wid);
            break;
        case 'decode':
            decode_draw_packet(data.packet, data.start);
            break
        case 'canvas':
            add_decoders_for_window(data.wid, data.canvas)
            break;
        case 'canvas-geo':
            const oc =  offscreen_canvas.get(data.wid);
            if (oc) {
                const canvas = oc["c"];
                if (canvas.width != data.w || canvas.height != data.h) {
                    canvas.width = data.w;
                    canvas.height = data.h;
                }
            }
            break;
        default:
            console.error("Offscreen decode worker got unknown message: " + data.cmd);
    }
}