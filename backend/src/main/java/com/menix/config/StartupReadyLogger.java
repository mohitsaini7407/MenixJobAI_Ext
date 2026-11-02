package com.menix.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Instant;

@Component
public class StartupReadyLogger {
    private static final Logger log = LoggerFactory.getLogger(StartupReadyLogger.class);

    @EventListener(ApplicationReadyEvent.class)
    public void logReady() {
        Runtime runtime = Runtime.getRuntime();
        log.info("{} STARTUP ApplicationReadyEvent maxHeapBytes={} availableProcessors={}",
            Instant.now(), runtime.maxMemory(), runtime.availableProcessors());
    }
}
