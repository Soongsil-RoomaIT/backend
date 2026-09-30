package kr.ac.roomcare.notification.service;

import java.util.Map;

interface FcmSender {
    void send(String token, String title, String body, Map<String, String> data);
}

