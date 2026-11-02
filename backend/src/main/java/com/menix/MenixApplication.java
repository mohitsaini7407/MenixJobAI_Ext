package com.menix;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;
import java.lang.management.ManagementFactory;
import java.time.Instant;
import javax.management.ObjectName;
@SpringBootApplication
@EnableScheduling
public class MenixApplication {
 public static void main(String[] args) {
  System.out.printf("%s STARTUP main() entered%n", Instant.now());
  System.out.printf("%s STARTUP maxHeapBytes=%d availableProcessors=%d%n", Instant.now(),
   Runtime.getRuntime().maxMemory(), Runtime.getRuntime().availableProcessors());
  enableGcLoggingWhenRequested();
  SpringApplication.run(MenixApplication.class, args);
 }

 private static void enableGcLoggingWhenRequested() {
  if (!"true".equalsIgnoreCase(System.getenv("DEBUG_GC"))) return;
  try {
   ManagementFactory.getPlatformMBeanServer().invoke(
    new ObjectName("com.sun.management:type=DiagnosticCommand"), "vmLog",
    new Object[]{new String[]{"output=stdout", "what=gc", "decorators=time"}},
    new String[]{String[].class.getName()});
   System.out.printf("%s STARTUP DEBUG_GC enabled (GC output=stdout, decorators=time)%n", Instant.now());
  } catch (Exception ex) {
   System.err.printf("%s STARTUP DEBUG_GC could not be enabled (%s)%n", Instant.now(), ex.getClass().getSimpleName());
  }
 }
}
