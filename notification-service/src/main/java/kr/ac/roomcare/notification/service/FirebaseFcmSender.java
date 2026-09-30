package kr.ac.roomcare.notification.service;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.FirebaseMessagingException;
import com.google.firebase.messaging.Message;
import com.google.firebase.messaging.Notification;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnBean(FirebaseApp.class)
@ConditionalOnExpression("T(org.springframework.util.StringUtils).hasText('${firebase.credentials-path:}')")
class FirebaseFcmSender implements FcmSender {
    @Override
    public void send(String token, String title, String body, Map<String, String> data) {
        Message message = Message.builder().setToken(token)
            .setNotification(Notification.builder().setTitle(title).setBody(body).build())
            .putAllData(data).build();
        try {
            FirebaseMessaging.getInstance().send(message);
        } catch (FirebaseMessagingException e) {
            throw new IllegalStateException("FCM send failed", e);
        }
    }
}

