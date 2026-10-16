import com.salesforce.dataloader.action.progress.NihilistProgressAdapter;
import com.salesforce.dataloader.config.AppConfig;
import com.salesforce.dataloader.controller.Controller;
import com.salesforce.dataloader.security.EncryptionAesUtil;
import com.salesforce.dataloader.util.AppUtil;
import com.sforce.soap.partner.GetUserInfoResult;
import com.sforce.soap.partner.fault.ApiFault;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;

/**
 * Kauro qualification launcher for the official Salesforce Data Loader.
 *
 * WHAT THIS IS. A thin, qualification-only entry point around the PUBLIC API of
 * the unmodified Data Loader release jar (v67.0.0): {@code Controller.getInstance},
 * {@code login}, {@code setFieldTypes}, {@code initializeOperation},
 * {@code executeAction}, {@code logout}. The engine that reads the CSV, maps it,
 * batches it and writes success/error files is Data Loader's own; nothing here
 * replaces it, patches it or reflects into it.
 *
 * WHY IT EXISTS. Data Loader's batch entry point ({@code ProcessRunner.run})
 * calls {@code handleOAuthLogin} first, and that method starts a browser PKCE
 * flow whenever {@code sfdc.username} and {@code sfdc.password} are not both
 * present -- an access token does not disable it. {@code LoginClient.dologin}
 * does honour a token: when {@code sfdc.oauth.accesstoken} is non-empty it
 * connects to {@code salesforce.oauth.instanceURL} and validates the session
 * with {@code getUserInfo}. This launcher reaches that path by calling the
 * Controller directly, so no browser can be opened: the browser-launching code
 * ({@code OAuthFlowHandler}, {@code OAuthServerFlow}, {@code ui.URLUtil}) is
 * never on the call graph. {@code AppConfig.getLastOAuthFlow()} is read before
 * and after; the browser flow sets it to "PKCE" on its first line, so an
 * unchanged value is evidence that the flow was never entered.
 *
 * SECRETS. The access token and the instance URL arrive on STDIN (two lines),
 * never on the command line and never in a file inside the repository. Data
 * Loader requires {@code sfdc.oauth.accesstoken} to be AES-encrypted with the
 * key named by {@code process.encryptionKeyFile}; the key file is created in a
 * per-run directory the caller deletes, the token is encrypted in memory, and
 * the plaintext is never written. The caller scans every output for the token
 * bytes afterwards. This program prints exactly one JSON line to STDOUT and
 * never prints the token.
 *
 * SPEC. argv[0] is a Java properties file (no secrets) with:
 *   configDir, keyFile, entity, operation (insert|update|upsert|delete),
 *   externalIdField (upsert), mappingFile, inputCsv, successFile, errorFile,
 *   expectedOrgId, expectedUserId (optional), loadBatchSize, timeoutSecs.
 *
 * EXIT CODES. 0 OK; 10 AUTH_INVALID; 11 IDENTITY_MISMATCH; 12 CONFIG_ERROR;
 * 13 OPERATION_ERROR; 14 VENDOR_FAILURE; 15 BROWSER_FLOW_ENTERED; 64 USAGE.
 */
public final class KauroDataLoaderLauncher {

    private static final String LAUNCHER_VERSION = "1.0.0";

    private KauroDataLoaderLauncher() {}

    public static void main(String[] args) {
        int code;
        try {
            code = run(args);
        } catch (Throwable t) {
            code = emit("VENDOR_FAILURE", 14, fields("error", describe(t)));
        }
        System.exit(code);
    }

    private static int run(String[] args) throws Exception {
        if (args.length != 1) {
            return emit("USAGE", 64, fields("error", "usage: KauroDataLoaderLauncher <spec.properties>  (token and instance URL on stdin, two lines)"));
        }
        Properties spec = new Properties();
        try (FileInputStream in = new FileInputStream(args[0])) {
            spec.load(new InputStreamReader(in, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return emit("CONFIG_ERROR", 12, fields("error", "spec unreadable: " + describe(e)));
        }
        for (String required : new String[] {"configDir", "keyFile", "entity", "operation", "mappingFile", "inputCsv", "successFile", "errorFile", "expectedOrgId"}) {
            if (blank(spec.getProperty(required))) {
                return emit("CONFIG_ERROR", 12, fields("error", "spec is missing " + required));
            }
        }
        String operation = spec.getProperty("operation");
        if (!operation.equals("insert") && !operation.equals("update") && !operation.equals("upsert") && !operation.equals("delete")) {
            return emit("CONFIG_ERROR", 12, fields("error", "operation must be insert, update, upsert or delete"));
        }
        if (operation.equals("upsert") && blank(spec.getProperty("externalIdField"))) {
            return emit("CONFIG_ERROR", 12, fields("error", "upsert names no externalIdField"));
        }
        for (String pathKey : new String[] {"mappingFile", "inputCsv"}) {
            if (!Files.isRegularFile(Paths.get(spec.getProperty(pathKey)))) {
                return emit("CONFIG_ERROR", 12, fields("error", pathKey + " does not exist: " + spec.getProperty(pathKey)));
            }
        }

        // ---- the secret channel: stdin, two lines, read once, never echoed ----
        BufferedReader stdin = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String token = stdin.readLine();
        String instanceUrl = stdin.readLine();
        if (blank(token) || blank(instanceUrl)) {
            return emit("CONFIG_ERROR", 12, fields("error", "stdin must carry the access token on line 1 and the instance URL on line 2"));
        }
        token = token.trim();
        instanceUrl = instanceUrl.trim();
        if (instanceUrl.endsWith("/")) instanceUrl = instanceUrl.substring(0, instanceUrl.length() - 1);
        if (!instanceUrl.startsWith("https://")) {
            return emit("CONFIG_ERROR", 12, fields("error", "instance URL must be https"));
        }

        // Batch mode: a decrypt failure throws instead of blanking the token, and
        // no SWT display is ever touched on this code path.
        AppUtil.setAppRunMode("batch");

        // ---- encrypt the token with a per-run key the caller deletes ----
        String keyFile = spec.getProperty("keyFile");
        EncryptionAesUtil encrypter = new EncryptionAesUtil();
        encrypter.createKeyFileIfNotExisting(keyFile);
        encrypter.setCipherKeyFromFilePath(keyFile);
        String encryptedToken = encrypter.encryptMsg(token);

        Map<String, String> config = new HashMap<>();
        config.put("salesforce.config.dir", spec.getProperty("configDir"));
        config.put("process.encryptionKeyFile", keyFile);
        config.put(AppConfig.PROP_OAUTH_ACCESSTOKEN, encryptedToken);
        config.put(AppConfig.PROP_OAUTH_INSTANCE_URL, instanceUrl);
        // The session's server is derived from the authentication endpoint, so
        // the endpoint must be the instance the token belongs to.
        config.put(AppConfig.PROP_AUTH_ENDPOINT_PROD, instanceUrl + "/");
        config.put(AppConfig.PROP_SELECTED_SERVER_ENVIRONMENT, AppConfig.SERVER_PROD_ENVIRONMENT_VAL);
        config.put(AppConfig.PROP_ENTITY, spec.getProperty("entity"));
        config.put(AppConfig.PROP_OPERATION, operation);
        config.put(AppConfig.PROP_MAPPING_FILE, spec.getProperty("mappingFile"));
        config.put(AppConfig.PROP_DAO_TYPE, "csvRead");
        config.put(AppConfig.PROP_DAO_NAME, spec.getProperty("inputCsv"));
        config.put(AppConfig.PROP_OUTPUT_SUCCESS, spec.getProperty("successFile"));
        config.put(AppConfig.PROP_OUTPUT_ERROR, spec.getProperty("errorFile"));
        config.put("process.enableExtractStatusOutput", "true");
        config.put("process.enableLastRunOutput", "false");
        config.put("dataAccess.readUTF8", "true");
        config.put("dataAccess.writeUTF8", "true");
        config.put("sfdc.loadBatchSize", spec.getProperty("loadBatchSize", "200"));
        config.put("sfdc.timeoutSecs", spec.getProperty("timeoutSecs", "600"));
        config.put("sfdc.debugMessages", "false");
        config.put("sfdc.useBulkApi", "false");
        config.put("loader.ui.showUpgrade", "false");
        if (operation.equals("upsert")) {
            config.put("sfdc.externalIdField", spec.getProperty("externalIdField"));
        }

        Controller controller;
        try {
            controller = Controller.getInstance(config);
        } catch (Exception e) {
            return emit("CONFIG_ERROR", 12, fields("error", "Controller.getInstance refused the configuration: " + describe(e)));
        }
        AppConfig appConfig = controller.getAppConfig();
        String flowBefore = appConfig.getLastOAuthFlow();

        // ---- login through LoginClient.dologin's token path ----
        boolean loggedIn;
        try {
            loggedIn = controller.login();
        } catch (Exception e) {
            String exceptionCode = apiFaultCode(e);
            if ("INVALID_SESSION_ID".equals(exceptionCode) || "INVALID_LOGIN".equals(exceptionCode)) {
                return finish(controller, appConfig, flowBefore, "AUTH_INVALID", 10, fields("error", exceptionCode + ": " + describe(e)));
            }
            return finish(controller, appConfig, flowBefore, "VENDOR_FAILURE", 14, fields("error", describe(e)));
        }
        if (!loggedIn) {
            return finish(controller, appConfig, flowBefore, "AUTH_INVALID", 10, fields("error", "Controller.login returned false"));
        }

        // ---- who the session is, before anything is written ----
        GetUserInfoResult who = controller.getLoginClient().getSession().getUserInfoResult();
        if (who == null) {
            return finish(controller, appConfig, flowBefore, "VENDOR_FAILURE", 14, fields("error", "the session carries no user info"));
        }
        Map<String, String> identity = new LinkedHashMap<>();
        identity.put("orgId", who.getOrganizationId());
        identity.put("userId", who.getUserId());
        identity.put("userName", who.getUserName());
        identity.put("organizationName", who.getOrganizationName());
        String expectedOrgId = spec.getProperty("expectedOrgId");
        String expectedUserId = spec.getProperty("expectedUserId");
        if (!expectedOrgId.equals(who.getOrganizationId())
                || (!blank(expectedUserId) && !expectedUserId.equals(who.getUserId()))) {
            identity.put("error", "the session belongs to org " + who.getOrganizationId() + " user " + who.getUserId()
                    + " and the run expected org " + expectedOrgId + (blank(expectedUserId) ? "" : " user " + expectedUserId));
            return finish(controller, appConfig, flowBefore, "IDENTITY_MISMATCH", 11, identity);
        }

        // ---- the operation, on Data Loader's own engine ----
        NihilistProgressAdapter monitor = new NihilistProgressAdapter();
        try {
            controller.setFieldTypes();
            controller.initializeOperation("csvRead", spec.getProperty("inputCsv"), spec.getProperty("entity"));
            controller.executeAction(monitor);
        } catch (Exception e) {
            identity.put("error", describe(e));
            return finish(controller, appConfig, flowBefore, "OPERATION_ERROR", 13, identity);
        }
        identity.put("operationSuccess", String.valueOf(monitor.isSuccess()));
        identity.put("operationMessage", monitor.getMessage() == null ? "" : monitor.getMessage());
        identity.put("rowsWithError", String.valueOf(monitor.getNumberRowsWithError()));
        identity.put("batches", String.valueOf(monitor.getNumberBatchesTotal()));
        identity.put("successFile", spec.getProperty("successFile"));
        identity.put("errorFile", spec.getProperty("errorFile"));
        return finish(controller, appConfig, flowBefore, monitor.isSuccess() ? "OK" : "OPERATION_ERROR", monitor.isSuccess() ? 0 : 13, identity);
    }

    /** Logs out, checks the browser flow was never entered, deletes nothing the caller owns, and prints the one JSON line. */
    private static int finish(Controller controller, AppConfig appConfig, String flowBefore, String exitClass, int code, Map<String, String> extra) {
        String flowAfter = appConfig.getLastOAuthFlow();
        boolean browserFlowEntered = !same(flowBefore, flowAfter);
        try {
            controller.logout();
        } catch (Throwable ignored) {
            // A failed logout after a completed decision does not change the decision.
        }
        Map<String, String> out = new LinkedHashMap<>(extra);
        out.put("lastOAuthFlowBefore", flowBefore == null ? "" : flowBefore);
        out.put("lastOAuthFlowAfter", flowAfter == null ? "" : flowAfter);
        out.put("browserFlowEntered", String.valueOf(browserFlowEntered));
        if (browserFlowEntered) {
            out.put("error", "the OAuth browser flow was entered, which this launcher must make impossible");
            return emit("BROWSER_FLOW_ENTERED", 15, out);
        }
        return emit(exitClass, code, out);
    }

    private static String apiFaultCode(Throwable t) {
        Throwable cursor = t;
        while (cursor != null) {
            if (cursor instanceof ApiFault) {
                ApiFault fault = (ApiFault) cursor;
                return fault.getExceptionCode() == null ? "" : fault.getExceptionCode().toString();
            }
            cursor = cursor.getCause();
        }
        String text = describe(t);
        if (text.contains("INVALID_SESSION_ID")) return "INVALID_SESSION_ID";
        return "";
    }

    private static int emit(String exitClass, int code, Map<String, String> extra) {
        StringBuilder json = new StringBuilder();
        json.append("{\"launcher\":\"KauroDataLoaderLauncher\",\"launcherVersion\":\"").append(LAUNCHER_VERSION).append("\"");
        json.append(",\"exitClass\":\"").append(escape(exitClass)).append("\",\"exitCode\":").append(code);
        json.append(",\"ok\":").append(code == 0);
        for (Map.Entry<String, String> entry : extra.entrySet()) {
            json.append(",\"").append(escape(entry.getKey())).append("\":\"").append(escape(entry.getValue())).append("\"");
        }
        json.append("}");
        System.out.println(json);
        System.out.flush();
        return code;
    }

    private static Map<String, String> fields(String key, String value) {
        Map<String, String> map = new LinkedHashMap<>();
        map.put(key, value == null ? "" : value);
        return map;
    }

    private static boolean blank(String value) {
        return value == null || value.trim().isEmpty();
    }

    private static boolean same(String a, String b) {
        return (a == null ? "" : a).equals(b == null ? "" : b);
    }

    private static String describe(Throwable t) {
        StringBuilder text = new StringBuilder();
        Throwable cursor = t;
        int depth = 0;
        while (cursor != null && depth < 5) {
            if (depth > 0) text.append(" <- ");
            text.append(cursor.getClass().getSimpleName()).append(": ").append(cursor.getMessage() == null ? "" : cursor.getMessage());
            cursor = cursor.getCause();
            depth += 1;
        }
        return text.toString();
    }

    private static String escape(String value) {
        StringBuilder out = new StringBuilder();
        for (char c : value.toCharArray()) {
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
            }
        }
        return out.toString();
    }
}
