package xyz.yoshling.screenshots.mixin;

import net.minecraft.client.multiplayer.ClientPacketListener;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import xyz.yoshling.screenshots.YoshlingScreenshotsClient;

@Mixin(ClientPacketListener.class)
public abstract class ClientPacketListenerMixin {
    /** Also protect commands submitted programmatically by another client component. */
    @Inject(method = "sendCommand", at = @At("HEAD"), cancellable = true)
    private void yoshlingNeverSendCommand(String text, CallbackInfo info) {
        if (YoshlingScreenshotsClient.localCommand(text)) info.cancel();
    }
}
