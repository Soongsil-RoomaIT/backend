package kr.ac.roomcare.notification.service;

import com.google.auth.oauth2.GoogleCredentials;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import java.io.FileInputStream;
import java.io.IOException;
import org.springframework.boot.autoconfigure.condition.ConditionalOnExpression;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
class FirebaseConfig {
    @Bean
    @ConditionalOnExpression("T(org.springframework.util.StringUtils).hasText('${firebase.credentials-path:}')")
    FirebaseApp firebaseApp(org.springframework.core.env.Environment environment) throws IOException {
        String path = environment.getRequiredProperty("firebase.credentials-path");
        try (FileInputStream input = new FileInputStream(path)) {
            FirebaseOptions options = FirebaseOptions.builder()
                .setCredentials(GoogleCredentials.fromStream(input))
                .build();
            return FirebaseApp.initializeApp(options);
        }
    }
}

