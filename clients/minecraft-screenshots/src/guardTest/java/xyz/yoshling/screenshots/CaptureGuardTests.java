package xyz.yoshling.screenshots;

import java.io.IOException;
import java.lang.classfile.ClassFile;
import java.lang.classfile.ClassModel;
import java.lang.classfile.Annotation;
import java.lang.classfile.AnnotationValue;
import java.lang.classfile.attribute.RuntimeVisibleAnnotationsAttribute;
import java.lang.classfile.attribute.RuntimeInvisibleAnnotationsAttribute;
import java.lang.classfile.instruction.InvokeInstruction;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/** Offline assertions only: no Minecraft client, graphics, network or game world. */
public final class CaptureGuardTests {
    private static int checks;
    private static final String CODE = "A".repeat(43);
    private static final String PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String SESSION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String TOKEN = PROFILE + "@cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    private static final String WAITING = """
            {"protocol":1,"state":"waiting","sessionId":"%s","profileId":"%s","profileName":"Cozy world",
             "contextToken":"%s","profileRevision":5,"expiresAt":"2099-01-01T00:00:00Z",
             "maxBytes":5242880,"maxPixels":16000000,"uploadUrl":"https://yoshling.xyz/api/minecraft/capture"}
            """.formatted(SESSION, PROFILE, TOKEN);
    public static void main(String[] ignored) throws Exception {
        commands(); protocol(); session(); bounds(); hud(); deadlines(); queue(); nativeApi();
        System.out.println("Verified " + checks + " offline companion guards.");
    }
    private static void commands() {
        check(LocalCommand.parse("/yoshling pair " + CODE).kind() == LocalCommand.Kind.PAIR, "pair command");
        check(LocalCommand.parse("yoshling capture").kind() == LocalCommand.Kind.CAPTURE, "packet command");
        check(LocalCommand.parseChat("yoshling hello") == null &&
                LocalCommand.parseChat("yoshling pair " + CODE) == null, "ordinary chat preserved");
        check(LocalCommand.parseChat("/yoshling capture").kind() == LocalCommand.Kind.CAPTURE, "slash-prefixed chat command");
        check(LocalCommand.parse("/yoshling pair invalid").kind() == LocalCommand.Kind.HELP, "invalid local input consumed");
        check(LocalCommand.parse("/yoshlingevil pair " + CODE) == null, "unrelated command preserved");
        check(!LocalCommand.parse("/yoshling pair " + CODE).toString().contains(CODE), "secret omitted from diagnostics");
        check(!LocalCommand.validCode("A".repeat(42)) && !LocalCommand.validCode("A".repeat(44)), "exact code length");
    }
    private static void protocol() {
        check(CaptureProtocol.serverAddress("MC.YOSHLING.XYZ").equals("mc.yoshling.xyz:25565"), "hostname normalization");
        check(CaptureProtocol.serverAddress("89.58.50.155:25565").equals("89.58.50.155:25565"), "approved address");
        for (String value : List.of("localhost", "mc.yoshling.xyz:123", "mc.yoshling.xyz.evil", "https://yoshling.xyz", "89.58.50.155/path"))
            rejects(() -> CaptureProtocol.serverAddress(value), "unapproved host rejected");
        rejects(() -> CaptureProtocol.requireVersion("26.2"), "wrong game version");
        CaptureProtocol.Context context = CaptureProtocol.context(WAITING);
        check(context.expiresAt().equals(Instant.parse("2099-01-01T00:00:00Z")), "ISO expiry");
        for (String value : List.of(WAITING.replace("5242880", "5242881"), WAITING.replace("16000000", "16000001"),
                WAITING.replace("https://yoshling.xyz/api/minecraft/capture", "https://evil.example/api/minecraft/capture"),
                WAITING.replace("\"profileRevision\":5", "\"profileRevision\":5.5"),
                WAITING.replace("\"protocol\":1", "\"protocol\":\"1\""), WAITING.replace("\"protocol\":1", "\"protocol\":2"),
                WAITING.replace("\"waiting\"", "\"unknown\""),
                WAITING.replace(TOKEN, "wrong-profile@token")))
            rejects(() -> CaptureProtocol.context(value), "malformed context rejected");
        CaptureProtocol.Context changed = CaptureProtocol.context(WAITING.replace("\"profileRevision\":5", "\"profileRevision\":6"));
        rejects(() -> CaptureProtocol.sameContext(context, changed), "metadata rebind refused");
        CaptureProtocol.Context switched = CaptureProtocol.context(WAITING.replace("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
        rejects(() -> CaptureProtocol.sameContext(context, switched), "runtime rebind refused");
        String receipt = """
                {"protocol":1,"state":"complete","sessionId":"%s","profileId":"%s","verified":true,
                 "profile":{"id":"%s","revision":6,"coverUrl":"/api/minecraft/profiles/%s/cover?v=6"}}
                """.formatted(SESSION, PROFILE, PROFILE, PROFILE);
        CaptureProtocol.receipt(receipt, context); checks++;
        for (String bad : List.of(receipt.replace("\"verified\":true", "\"verified\":false"), receipt.replace("\"revision\":6", "\"revision\":7"),
                receipt.replace("/cover?v=6", "/cover?v=7"), receipt.replace(SESSION, PROFILE), receipt.replace("\"complete\"", "\"waiting\"")))
            rejects(() -> CaptureProtocol.receipt(bad, context), "unconfirmed upload rejected");
    }
    private static void session() {
        long start = 1_000_000_000L; Object connection = new Object(), world = new Object();
        CaptureSession state = new CaptureSession(); state.observe(connection, world, start); state.pair(CODE, start);
        check(state.next(start + CaptureSession.WORLD_DELAY - 1, true) == null, "world warmup");
        check(state.next(start + CaptureSession.WORLD_DELAY, false) == null, "chat/menu capture refused");
        CaptureSession.Job job = state.next(start + CaptureSession.WORLD_DELAY, true);
        check(job != null && state.next(start + CaptureSession.WORLD_DELAY, true) == null, "single outstanding request");
        check(!state.requestManual(), "manual request cannot overlap an in-flight job");
        check(!job.toString().contains(CODE), "job secret omitted");
        state.readFailed(job, false);
        check(state.next(start + CaptureSession.WORLD_DELAY + 1, true) == null, "no automatic read retry");
        check(state.requestManual(), "explicit recapture requested");
        CaptureSession.Job retry = state.next(start + CaptureSession.WORLD_DELAY + 2, true);
        check(retry != null, "explicit read retry admitted");
        state.accept(retry, CaptureProtocol.context(WAITING));
        CaptureSession.Frame frame = state.frame();
        check(frame != null && state.frame() == null, "one framebuffer claim");
        check(state.upload(frame.job()) && !state.upload(frame.job()), "one write admission");
        state.finish(frame.job()); check(!state.paired(), "grant cleared after completion");
        state.pair(CODE, start);
        state.requestManual();
        check(state.next(start + CaptureSession.PAIR_DELAY - 1, true) == null, "minimum compose delay");
        check(state.next(start + CaptureSession.PAIR_DELAY, true) != null, "manual warmup override after compose delay");
        state.observe(null, null, start + CaptureSession.PAIR_DELAY + 1);
        check(!state.paired() && !state.current(retry), "disconnect invalidates grant and late results");
        state.observe(connection, world, start); state.pair(CODE, start);
        CaptureSession.Job old = state.next(start + CaptureSession.WORLD_DELAY, true);
        state.pair(CODE, start + CaptureSession.WORLD_DELAY);
        check(!state.current(old), "same-code re-pair invalidates older generation");
        AtomicInteger obsolete = new AtomicInteger(), disposed = new AtomicInteger();
        state.dispatch(old, obsolete::incrementAndGet, disposed::incrementAndGet);
        check(obsolete.get() == 0 && disposed.get() == 1, "late old framebuffer cannot displace a new context job");
        state.observe(new Object(), new Object(), start + CaptureSession.WORLD_DELAY + 1);
        check(!state.paired() && !state.current(old), "connection replacement invalidates grant");
        state.observe(connection, world, start); state.pair(CODE, start);
        state.observe(connection, world, start + CaptureSession.LOCAL_EXPIRY);
        check(!state.paired(), "local expiry clears grant");
    }
    private static void bounds() throws Exception {
        check(CaptureProtocol.downscale(3840, 2160) == 3, "divisible native downscale");
        check(CaptureProtocol.downscale(1919, 1079) == 1, "odd native dimensions use safe factor");
        CaptureProtocol.Size odd = CaptureProtocol.outputSize(1919, 1079);
        check(odd.width() <= 1280 && odd.height() <= 800, "odd dimensions resized before encoding");
        rejects(() -> CaptureProtocol.downscale(0, 100), "invalid framebuffer");
        rejects(() -> CaptureProtocol.downscale(8000, 8000), "readback pixel budget");
        BoundedBytes output = new BoundedBytes(8); output.write(ByteBuffer.wrap(new byte[8]));
        check(output.bytes().length == 8, "exact byte bound");
        ioRejects(() -> output.write(ByteBuffer.wrap(new byte[1])), "byte overflow rejected");
        ioRejects(output::bytes, "swallowed encoder exception still refuses publication");
        ResponseBody body = new ResponseBody(8); AtomicInteger cancelled = new AtomicInteger();
        body.onSubscribe(new Flow.Subscription() { public void request(long count) {} public void cancel() { cancelled.incrementAndGet(); } });
        body.onNext(List.of(ByteBuffer.wrap(new byte[9])));
        check(cancelled.get() == 1 && body.getBody().toCompletableFuture().isCompletedExceptionally(), "oversized response cancelled");
    }
    private static void hud() {
        boolean[] hidden = {false};
        HudScope.hidden(() -> hidden[0], value -> hidden[0] = value, () -> check(hidden[0], "HUD suppressed during extraction"));
        check(!hidden[0], "HUD preference restored");
        rejects(() -> HudScope.hidden(() -> hidden[0], value -> hidden[0] = value, () -> { throw new IllegalArgumentException(); }), "render failure");
        check(!hidden[0], "HUD restored after render failure");
        hidden[0] = true; HudScope.hidden(() -> hidden[0], value -> hidden[0] = value, () -> {});
        check(hidden[0], "existing hidden HUD remains hidden");
    }
    private static void deadlines() throws Exception {
        CompletableFuture<String> stalledBody = new CompletableFuture<>();
        long started = System.nanoTime();
        ioRejects(() -> ExchangeDeadline.await(stalledBody, Duration.ofMillis(5)), "whole response deadline");
        check(System.nanoTime() - started < Duration.ofMillis(200).toNanos(), "body stall stops at its whole-exchange deadline");
        check(stalledBody.isCancelled(), "stalled exchange cancelled");
        check(ExchangeDeadline.await(CompletableFuture.completedFuture("okay"), Duration.ofSeconds(1)).equals("okay"), "healthy response accepted");
    }
    private static void queue() throws Exception {
        CountDownLatch running = new CountDownLatch(1), release = new CountDownLatch(1), last = new CountDownLatch(1);
        AtomicInteger discarded = new AtomicInteger(), obsoleteRuns = new AtomicInteger();
        try (LatestWork work = new LatestWork()) {
            work.submit(() -> { running.countDown(); try { release.await(); } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } }, () -> {});
            check(running.await(1, TimeUnit.SECONDS), "worker started");
            work.submit(obsoleteRuns::incrementAndGet, discarded::incrementAndGet);
            work.submit(last::countDown, () -> {});
            check(discarded.get() == 1, "obsolete queued resource disposed");
            release.countDown(); check(last.await(1, TimeUnit.SECONDS), "latest work resumes");
            check(obsoleteRuns.get() == 0, "obsolete work never executes");
        } finally { release.countDown(); }
    }
    private static void nativeApi() throws Exception {
        member("net/minecraft/client/Screenshot", "takeScreenshot", "(Lcom/mojang/blaze3d/pipeline/RenderTarget;ILjava/util/function/Consumer;)V");
        member("com/mojang/blaze3d/platform/NativeImage", "writeToChannel", "(Ljava/nio/channels/WritableByteChannel;)Z");
        member("net/minecraft/client/Minecraft", "tick", "()V");
        member("net/minecraft/client/Minecraft", "runTick", "(Z)V");
        member("net/minecraft/client/Minecraft", "renderFrame", "(Z)V");
        member("net/minecraft/client/gui/screens/ChatScreen", "handleChatInput", "(Ljava/lang/String;Z)V");
        member("net/minecraft/client/multiplayer/ClientPacketListener", "sendCommand", "(Ljava/lang/String;)V");
        member("net/minecraft/client/renderer/GameRenderer", "extract", "(Lnet/minecraft/client/DeltaTracker;Z)V");
        member("net/minecraft/client/renderer/GameRenderer", "render", "(Lnet/minecraft/client/DeltaTracker;Z)V");
        localInterceptor("ChatScreenMixin", "yoshlingLocalInput", "handleChatInput");
        localInterceptor("ClientPacketListenerMixin", "yoshlingNeverSendCommand", "sendCommand");
        ClassModel minecraft = classModel("net/minecraft/client/Minecraft");
        String selector = frameSelector("yoshlingExtract");
        check(selector.equals(frameSelector("yoshlingRender")), "capture hooks share the actual frame method");
        var frame = minecraft.methods().stream().filter(method -> method.methodName().stringValue().equals(selector)).findFirst().orElseThrow();
        List<String> calls = frame.code().orElseThrow().elementList().stream().filter(element -> element instanceof InvokeInstruction)
                .map(element -> (InvokeInstruction) element)
                .filter(call -> call.owner().name().stringValue().equals("net/minecraft/client/renderer/GameRenderer"))
                .map(call -> call.name().stringValue()).toList();
        check(calls.indexOf("extract") >= 0 && calls.indexOf("extract") < calls.indexOf("render"), "HUD extraction precedes framebuffer capture");
    }
    private static String frameSelector(String hook) throws Exception {
        var method = classModel("xyz/yoshling/screenshots/mixin/MinecraftMixin").methods().stream()
                .filter(member -> member.methodName().stringValue().equals(hook)).findFirst().orElseThrow();
        List<Annotation> annotations = method.attributes().stream().flatMap(attribute -> {
            if (attribute instanceof RuntimeVisibleAnnotationsAttribute visible) return visible.annotations().stream();
            if (attribute instanceof RuntimeInvisibleAnnotationsAttribute invisible) return invisible.annotations().stream();
            return java.util.stream.Stream.empty();
        }).toList();
        Annotation wrapper = annotations.stream().filter(annotation -> annotation.className().stringValue()
                .equals("Lcom/llamalad7/mixinextras/injector/wrapoperation/WrapOperation;")).findFirst().orElseThrow();
        var value = wrapper.elements().stream().filter(element -> element.name().stringValue().equals("method")).findFirst().orElseThrow().value();
        var values = ((AnnotationValue.OfArray) value).values();
        check(values.size() == 1, "one native frame selector");
        return ((AnnotationValue.OfString) values.getFirst()).stringValue();
    }
    private static void localInterceptor(String mixin, String hook, String target) throws Exception {
        var method = classModel("xyz/yoshling/screenshots/mixin/" + mixin).methods().stream()
                .filter(member -> member.methodName().stringValue().equals(hook)).findFirst().orElseThrow();
        Annotation inject = method.attributes().stream().flatMap(attribute -> {
            if (attribute instanceof RuntimeVisibleAnnotationsAttribute visible) return visible.annotations().stream();
            if (attribute instanceof RuntimeInvisibleAnnotationsAttribute invisible) return invisible.annotations().stream();
            return java.util.stream.Stream.<Annotation>empty();
        }).filter(annotation -> annotation.className().stringValue().equals("Lorg/spongepowered/asm/mixin/injection/Inject;")).findFirst().orElseThrow();
        var elements = inject.elements();
        var selectors = (AnnotationValue.OfArray) elements.stream().filter(element -> element.name().stringValue().equals("method")).findFirst().orElseThrow().value();
        check(selectors.values().size() == 1 && ((AnnotationValue.OfString) selectors.values().getFirst()).stringValue().equals(target), "exact local command interceptor");
        var ats = (AnnotationValue.OfArray) elements.stream().filter(element -> element.name().stringValue().equals("at")).findFirst().orElseThrow().value();
        Annotation at = ((AnnotationValue.OfAnnotation) ats.values().getFirst()).annotation();
        var position = (AnnotationValue.OfString) at.elements().stream().filter(element -> element.name().stringValue().equals("value")).findFirst().orElseThrow().value();
        check(position.stringValue().equals("HEAD"), "secret intercepted before history/network");
        var cancellable = (AnnotationValue.OfBoolean) elements.stream().filter(element -> element.name().stringValue().equals("cancellable")).findFirst().orElseThrow().value();
        check(cancellable.booleanValue(), "local command cannot fall through");
    }
    private static void member(String owner, String name, String descriptor) throws Exception {
        check(classModel(owner).methods().stream().anyMatch(method -> method.methodName().stringValue().equals(name) &&
                method.methodType().stringValue().equals(descriptor)), "exact native API: " + owner + "." + name);
    }
    private static ClassModel classModel(String owner) throws Exception {
        try (var input = CaptureGuardTests.class.getClassLoader().getResourceAsStream(owner + ".class")) {
            if (input == null) throw new AssertionError("Missing exact game bytecode: " + owner);
            return ClassFile.of().parse(input.readAllBytes());
        }
    }
    private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); checks++; }
    private static void rejects(Runnable action, String label) {
        try { action.run(); throw new AssertionError(label); } catch (IllegalArgumentException expected) { checks++; }
    }
    @FunctionalInterface private interface Io { Object run() throws Exception; }
    private static void ioRejects(Io action, String label) throws Exception {
        try { action.run(); throw new AssertionError(label); } catch (IOException expected) { checks++; }
    }
}
