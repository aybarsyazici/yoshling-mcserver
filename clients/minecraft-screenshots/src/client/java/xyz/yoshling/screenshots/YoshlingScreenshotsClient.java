package xyz.yoshling.screenshots;

import com.mojang.blaze3d.platform.NativeImage;
import java.io.IOException;
import java.time.Instant;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.SharedConstants;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.network.chat.Component;
import xyz.yoshling.screenshots.mixin.NativeImageInvoker;

/** Nothing is registered on the game server or written to client configuration. */
public final class YoshlingScreenshotsClient implements ClientModInitializer {
    private static final CaptureSession SESSION = new CaptureSession();
    private static final CaptureHttp HTTP = new CaptureHttp();
    private static final LatestWork WORK = new LatestWork();
    private static CaptureSession.Frame pendingFrame;

    @Override public void onInitializeClient() {}
    public static boolean chatCommand(String input) {
        return LocalCommand.parseChat(input) != null && localCommand(input);
    }

    public static boolean localCommand(String input) {
        LocalCommand command = LocalCommand.parse(input);
        if (command == null) return false;
        Minecraft client = Minecraft.getInstance();
        try {
            updateWorld(client);
            if (command.kind() == LocalCommand.Kind.PAIR) {
                address(client);
                SESSION.pair(command.code(), System.nanoTime());
                say("Pairing code received. The dashboard will verify it before one screenshot is attempted; /yoshling capture requests it manually.");
            } else if (command.kind() == LocalCommand.Kind.CAPTURE) {
                if (SESSION.requestManual()) say("Screenshot requested. Close chat and compose your view.");
                else say(SESSION.paired() ? "A screenshot request is already in progress." : "Pair from the dashboard first.");
            } else say("Local commands: /yoshling pair <code> and /yoshling capture. Pairing codes are not sent to Minecraft.");
        } catch (IllegalArgumentException failure) {
            SESSION.clear(); say("Join mc.yoshling.xyz using Minecraft 26.1.2, then pair with a fresh dashboard code.");
        }
        return true; // Invalid commands in our namespace never fall through to the server.
    }

    public static void tick(Minecraft client) {
        updateWorld(client);
        CaptureSession.Job job = SESSION.next(System.nanoTime(), client.screen == null && client.getOverlay() == null);
        if (job == null) return;
        String address;
        try { address = address(client); } catch (IllegalArgumentException failure) { SESSION.finish(job); return; }
        WORK.submit(() -> {
            if (!SESSION.current(job)) return;
            try {
                CaptureProtocol.Context context = HTTP.context(job.code(), address);
                if (!context.expiresAt().isAfter(Instant.now())) throw new CaptureHttp.Refused(401);
                client.execute(() -> {
                    updateWorld(client);
                    try {
                        if (!SESSION.accept(job, context)) return;
                        if (context.complete() && SESSION.finish(job)) say("Screenshot upload was already verified. Check the dashboard.");
                    } catch (IllegalArgumentException failure) {
                        if (SESSION.finish(job)) say("The paired profile changed. Pair again from the dashboard.");
                    }
                });
            } catch (CaptureHttp.Refused failure) {
                client.execute(() -> { if (SESSION.readFailed(job, true)) say("Screenshot context refused (HTTP " + failure.status() + "). Pair again from the dashboard."); });
            } catch (Exception failure) {
                client.execute(() -> { if (SESSION.readFailed(job, false)) say("Screenshot context is unconfirmed. Check the dashboard, then use /yoshling capture to recheck."); });
            }
        }, () -> SESSION.readFailed(job, false));
    }

    /** Called before vanilla GUI extraction, after input handling for this frame. */
    public static boolean beginFrame(Minecraft client, boolean renderLevel) {
        updateWorld(client);
        pendingFrame = null;
        if (!renderLevel || client.screen != null || client.getOverlay() != null) return false;
        pendingFrame = SESSION.frame();
        return pendingFrame != null;
    }
    public static void cancelFrame() {
        if (pendingFrame != null) SESSION.finish(pendingFrame.job());
        pendingFrame = null;
    }
    /** Called after the extracted world/UI have actually rendered to the main target. */
    public static void rendered(Minecraft client) {
        CaptureSession.Frame frame = pendingFrame; pendingFrame = null;
        if (frame == null) return;
        updateWorld(client);
        if (!SESSION.current(frame.job()) || client.screen != null || client.getOverlay() != null) { SESSION.finish(frame.job()); return; }
        try {
            int scale = CaptureProtocol.downscale(client.getMainRenderTarget().width, client.getMainRenderTarget().height);
            Screenshot.takeScreenshot(client.getMainRenderTarget(), scale, image -> client.execute(() -> {
                updateWorld(client);
                SESSION.dispatch(frame.job(), () -> WORK.submit(() -> encodeAndUpload(client, frame, image), () -> {
                    image.close(); SESSION.finish(frame.job());
                }), image::close);
            }));
        } catch (Exception failure) {
            if (SESSION.finish(frame.job())) say("The screenshot could not be captured. Check the window size and pair again.");
        }
    }
    private static void encodeAndUpload(Minecraft client, CaptureSession.Frame frame, NativeImage image) {
        try {
            if (!SESSION.current(frame.job())) return;
            byte[] png = png(image);
            if (!SESSION.upload(frame.job())) return;
            HTTP.upload(frame.job().code(), frame.context(), png);
            client.execute(() -> { if (SESSION.finish(frame.job())) say("Screenshot upload verified. Check the dashboard."); });
        } catch (CaptureHttp.Refused failure) {
            client.execute(() -> { if (SESSION.finish(frame.job())) say("Screenshot upload refused (HTTP " + failure.status() + "). Check the dashboard before pairing again."); });
        } catch (Exception failure) {
            client.execute(() -> { if (SESSION.finish(frame.job())) say("The screenshot result is unconfirmed. Check the dashboard before pairing again; no upload was retried."); });
        } finally { image.close(); }
    }
    private static byte[] png(NativeImage image) throws IOException {
        CaptureProtocol.Size size = CaptureProtocol.outputSize(image.getWidth(), image.getHeight());
        NativeImage scaled = image;
        try {
            if (size.width() != image.getWidth() || size.height() != image.getHeight()) {
                scaled = new NativeImage(size.width(), size.height(), false);
                image.resizeSubRectTo(0, 0, image.getWidth(), image.getHeight(), scaled);
            }
            try (BoundedBytes channel = new BoundedBytes(CaptureProtocol.MAX_BYTES)) {
                if (!((NativeImageInvoker) (Object) scaled).yoshlingWritePng(channel)) throw new IOException("PNG encoding failed.");
                return channel.bytes();
            }
        } finally { if (scaled != image) scaled.close(); }
    }
    private static void updateWorld(Minecraft client) {
        try {
            address(client);
            SESSION.observe(client.getConnection(), client.level, System.nanoTime());
        } catch (IllegalArgumentException failure) { SESSION.observe(null, null, System.nanoTime()); }
    }
    private static String address(Minecraft client) {
        CaptureProtocol.requireVersion(SharedConstants.getCurrentVersion().id());
        if (client.isSingleplayer() || client.getConnection() == null || client.level == null || client.player == null || client.getCurrentServer() == null)
            throw new IllegalArgumentException("Join the supported server first.");
        return CaptureProtocol.serverAddress(client.getCurrentServer().ip);
    }
    private static void say(String message) {
        Minecraft client = Minecraft.getInstance();
        if (client.player != null) client.player.sendSystemMessage(Component.literal("[Yoshling] " + message));
    }
}
