FROM maven:3.9.9-eclipse-temurin-${{ values.runtime }} AS build
WORKDIR /workspace
COPY pom.xml .
RUN mvn -B -q dependency:go-offline
COPY src ./src
RUN mvn -B -q package -DskipTests

FROM eclipse-temurin:${{ values.runtime }}-jre
WORKDIR /app

# OpenTelemetry Java agent - enables automatic instrumentation, no source changes needed
ARG OTEL_JAVA_AGENT_VERSION=2.11.0
ADD https://github.com/open-telemetry/opentelemetry-java-instrumentation/releases/download/v${OTEL_JAVA_AGENT_VERSION}/opentelemetry-javaagent.jar /opt/otel/opentelemetry-javaagent.jar

COPY --from=build /workspace/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-javaagent:/opt/otel/opentelemetry-javaagent.jar", "-jar", "/app/app.jar"]
