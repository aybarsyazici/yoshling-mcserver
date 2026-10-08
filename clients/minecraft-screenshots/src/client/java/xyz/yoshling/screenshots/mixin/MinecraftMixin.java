package xyz.yoshling.screenshots.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import net.minecraft.client.DeltaTracker;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.GameRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import xyz.yoshling.screenshots.HudScope;
import xyz.yoshling.screenshots.YoshlingScreenshotsClient;

@Mixin(Minecraft.class)
public abstract class MinecraftMixin {
    @Inject(method = "tick", at = @At("TAIL"))
    private void yoshlingTick(CallbackInfo info) { YoshlingScreenshotsClient.tick((Minecraft) (Object) this); }

    @WrapOperation(method = "renderFrame", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/renderer/GameRenderer;extract(Lnet/minecraft/client/DeltaTracker;Z)V"))
    private void yoshlingExtract(GameRenderer renderer, DeltaTracker delta, boolean renderLevel, Operation<Void> original) {
        Minecraft client = (Minecraft) (Object) this;
        if (!YoshlingScreenshotsClient.beginFrame(client, renderLevel)) { original.call(renderer, delta, renderLevel); return; }
        try {
            HudScope.hidden(() -> client.options.hideGui, value -> client.options.hideGui = value,
                    () -> original.call(renderer, delta, renderLevel));
        } catch (RuntimeException | Error failure) { YoshlingScreenshotsClient.cancelFrame(); throw failure; }
    }
    @WrapOperation(method = "renderFrame", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/renderer/GameRenderer;render(Lnet/minecraft/client/DeltaTracker;Z)V"))
    private void yoshlingRender(GameRenderer renderer, DeltaTracker delta, boolean renderLevel, Operation<Void> original) {
        try { original.call(renderer, delta, renderLevel); }
        catch (RuntimeException | Error failure) { YoshlingScreenshotsClient.cancelFrame(); throw failure; }
        YoshlingScreenshotsClient.rendered((Minecraft) (Object) this);
    }
}
