package xyz.yoshling.screenshots;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

public final class HudScope {
    private HudScope() {}
    public static void hidden(BooleanSupplier current, Consumer<Boolean> apply, Runnable renderAndCapture) {
        boolean original = current.getAsBoolean();
        try { apply.accept(true); renderAndCapture.run(); }
        finally { apply.accept(original); }
    }
}
