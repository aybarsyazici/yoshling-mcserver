package xyz.yoshling.screenshots.mixin;

import net.minecraft.client.gui.screens.ChatScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import xyz.yoshling.screenshots.YoshlingScreenshotsClient;

@Mixin(ChatScreen.class)
public abstract class ChatScreenMixin {
    /** Before vanilla addRecentChat, so the pairing secret is never saved in history. */
    @Inject(method = "handleChatInput", at = @At("HEAD"), cancellable = true)
    private void yoshlingLocalInput(String text, boolean addToHistory, CallbackInfo info) {
        if (YoshlingScreenshotsClient.chatCommand(text)) info.cancel();
    }
}
