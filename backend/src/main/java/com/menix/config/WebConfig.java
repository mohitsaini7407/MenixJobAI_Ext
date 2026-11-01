package com.menix.config;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.*;
@Configuration
public class WebConfig implements WebMvcConfigurer {
 @Override public void addCorsMappings(CorsRegistry registry) {
  registry.addMapping("/api/**")
   .allowedOriginPatterns("http://localhost:*", "http://127.0.0.1:*", "file://", "chrome-extension://*")
   .allowedMethods("GET","POST","PUT","PATCH","DELETE","OPTIONS")
   .allowedHeaders("*");
 }
}
