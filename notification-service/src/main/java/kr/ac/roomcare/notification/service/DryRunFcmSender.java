package kr.ac.roomcare.notification.service;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnExpression("!T(org.springframework.util.StringUtils).hasText('${firebase.credentials-path:}')")
class DryRunFcmSender implements FcmSender {
    private static final Logger log = LoggerFactory.getLogger(DryRunFcmSender.class);

    @Override
    public void send(String token, String title, String body, Map<String, String> data) {
        log.info("FCM dry-run: tokenSuffix={}, title={}, dataKeys={}", suffix(token), title, data.keySet());
    }

    private String suffix(String token) {
        return token.length() <= 6 ? "******" : "***" + token.substring(token.length() - 6);
    }
}

