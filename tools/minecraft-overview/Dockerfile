FROM eclipse-temurin:25-jdk-noble@sha256:589ff4cc3f71aab462e7048a47a0d10edf57fbccde3fceea2281e610bf5880b4 AS jdk
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f AS build
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
WORKDIR /build
COPY package.json package-lock.json download-assets.mjs OfflineBlueMap.java ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && node download-assets.mjs /assets
RUN /opt/java/openjdk/bin/javac --release 25 -cp /assets/bluemap-5.28-cli.jar -d /bootstrap OfflineBlueMap.java \
 && /opt/java/openjdk/bin/jlink --add-modules java.base,java.desktop,java.logging,java.management,java.naming,java.net.http,java.prefs,java.sql,java.xml,jdk.crypto.ec,jdk.unsupported,jdk.zipfs --no-header-files --no-man-pages --output /jre \
 && chmod -R a+rX /assets /bootstrap /jre

FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f
COPY --from=build /jre /opt/java
COPY --from=build /assets /opt/overview/assets
COPY --from=build /bootstrap /opt/overview/bootstrap
COPY --from=build /build/node_modules /opt/overview/node_modules
WORKDIR /opt/overview
COPY package.json run.mjs screenshot.mjs ./
ENV JAVA_BINARY=/opt/java/bin/java
USER 0
ENTRYPOINT ["node", "/opt/overview/run.mjs"]
