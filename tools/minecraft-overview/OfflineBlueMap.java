import com.google.gson.Gson;
import de.bluecolored.bluemap.core.resources.VersionManifest;
import de.bluecolored.bluemap.cli.BlueMapCLI;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Arrays;

/** Pinned 5.28 bootstrap: use baked official metadata, never an execution-time fetch. */
public final class OfflineBlueMap {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) throw new IllegalArgumentException("Pinned manifest and CLI arguments required");
        Field gsonField = VersionManifest.class.getDeclaredField("GSON");
        gsonField.setAccessible(true);
        Gson gson = (Gson) gsonField.get(null);
        VersionManifest manifest;
        try (Reader reader = Files.newBufferedReader(Path.of(args[0]))) {
            manifest = gson.fromJson(reader, VersionManifest.class);
        }
        Method validate = VersionManifest.class.getDeclaredMethod("validate");
        validate.setAccessible(true); validate.invoke(manifest);
        Field instance = VersionManifest.class.getDeclaredField("instance");
        instance.setAccessible(true); instance.set(null, manifest);
        BlueMapCLI.main(Arrays.copyOfRange(args, 1, args.length));
    }
}
