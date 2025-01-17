class WT_NavigraphNetworkAPI {
    constructor(magicStrings) {
        this._chartListCache = new Map();
        this._chartCacheTimestamp = 0;
        this._accessTokenTimestamp = 0;
        this._magicStrings = magicStrings;
    }
    /** Gets a boolean indicating if the navigraph account is linked */
    get isAccountLinked() {
        return this.refreshToken !== "";
    }
    /** Sets the refresh token */
    set refreshToken(val) {
        WTDataStore.set(WT_NavigraphNetworkAPI.REFRESH_TOKEN_KEY, val);
    }
    get refreshToken() {
        return WTDataStore.get(WT_NavigraphNetworkAPI.REFRESH_TOKEN_KEY, "");
    }
    /** Returns a boolean indicating if a access token is known */
    get hasAccessToken() {
        return this.accessToken !== null;
    }
    /** Sets the access token */
    set accessToken(val) {
        localStorage.setItem(WT_NavigraphNetworkAPI.ACC_TOKEN_KEY, val);
        this._accessTokenTimestamp = Date.now();
    }
    /** Gets the access token */
    get accessToken() {
        return localStorage.getItem(WT_NavigraphNetworkAPI.ACC_TOKEN_KEY);
    }
    /**
     * Checks if the access token is still good or starts the link account process
     */
    validateToken() {
        return WT_Wait.awaitGenerator(this, void 0, void 0, function* () {
            if (this.isAccountLinked) {
                let success = true;
                if (!this.hasAccessToken ||
                    (this.hasAccessToken && (Date.now() - this._accessTokenTimestamp) > 900000)) {
                    success = yield this.refreshAccessToken();
                }
                return success;
            }
            else {
                return false;
            }
        });
    }
    /**
     * Refreshes the access token using the refresh token
     */
    refreshAccessToken() {
        return WT_Wait.awaitGenerator(this, void 0, void 0, function* () {
            const refreshForm = new Map([
                ["grant_type", "refresh_token"],
                ["refresh_token", this.refreshToken],
            ]);
            const refreshResp = yield this.sendRequest("https://identity.api.navigraph.com/connect/token", "post", refreshForm);
            if (refreshResp.ok) {
                this.refreshToken = refreshResp.json().refresh_token;
                this.accessToken = refreshResp.json().access_token;
                return true;
            }
            return false;
        });
    }
    /**
     * Gets a list of charts for the given ICAO
     * @param icao The ICAO of the airport to get the charts from
     * @returns {Promise<{charts:WT_NavigraphChartDefinition[]}>}
     */
    getChartsList(icao) {
        return WT_Wait.awaitGenerator(this, void 0, void 0, function* () {
            this.invalidateChartCache();
            let chartsObj;
            if (icao === "" || icao === "----") {
                return chartsObj;
            }
            if (!this._chartListCache.has(icao)) {
                let success = yield this.validateToken();
                if (!success) {
                    throw (WT_NavigraphNetworkAPI.Error.ACCESS_DENIED);
                }
                const signedUrlResp = yield this.sendRequest(`https://charts.api.navigraph.com/2/airports/${icao}/signedurls/charts.json`, "get", null, true);
                if (signedUrlResp.ok) {
                    const signedUrl = signedUrlResp.data;
                    const chartsListResp = yield this.sendRequest(signedUrl, "get");
                    if (chartsListResp.ok) {
                        chartsObj = chartsListResp.json();
                        this._chartListCache.set(icao, chartsObj);
                    }
                }
                return chartsObj;
            }
            else {
                return this._chartListCache.get(icao);
            }
        });
    }
    invalidateChartCache() {
        if (this._chartCacheTimestamp === 0 || ((Date.now() - this._chartCacheTimestamp) > 300000)) {
            this._chartCacheTimestamp = Date.now();
            this._chartListCache.clear();
        }
    }
    /**
     * Retrieves and prepares data needed for the account linking process.
     * @returns {Promise<{pkce:{code_verifier:String, code_challenge:String}, deviceCode:String, uri:String}>}
     *          a Promise to return the data required for the account linking process, or null if the data could not be
     *          retrieved.
     */
    async prepareAccountLink() {
        const pkce = WT_OAuthPkce.getChallenge(32);
        const authForm = new Map([
            ["code_challenge", pkce.code_challenge],
            ["code_challenge_method", "S256"]
        ]);
        let authResp = await this.sendRequest("https://identity.api.navigraph.com/connect/deviceauthorization", "post", authForm);
        if (authResp.ok) {
            return {pkce: pkce, deviceCode: authResp.json().device_code, uri: authResp.json().verification_uri_complete};
        } else {
            return null;
        }
    }

    /**
     * Executes the account linking process. This method will repeatedly request an account link from navigraph until
     * either a link is established or the process times out.
     * @param {{code_verifier:String, code_challenge:String}} pkce - the OAuth PKCE to use.
     * @param {String} deviceCode - the device code for which to link the account.
     * @param {Number} [timeout] - the maximum amount of time in milliseconds to spend attempting to establish an
     *                             account link. Defaults to 30000.
     * @returns {Promise<Boolean>} a Promise to return true if the account was successfully linked, or false if the
     *                             process timed out.
     */
    executeAccountLink(pkce, deviceCode, timeout = 30000) {
        return WT_Wait.awaitGenerator(this, void 0, void 0, function* () {
            this.refreshToken = "";
            this.accessToken = "";
            // poll for token
            const pollForm = new Map([
                ["grant_type", "urn:ietf:params:oauth:grant-type:device_code"],
                ["device_code", deviceCode],
                ["scope", "openid charts offline_access"],
                ["code_verifier", pkce.code_verifier]
            ]);
            let t0 = Date.now();
            while (Date.now() - t0 < timeout) {
                yield WT_Wait.wait(4000);
                const pollResp = yield this.sendRequest("https://identity.api.navigraph.com/connect/token", "post", pollForm);
                if (pollResp.ok) {
                    this.refreshToken = pollResp.json().refresh_token;
                    this.accessToken = pollResp.json().access_token;
                    return true;
                }
            }
            return false;
        });
    }
    /** Gets the signed png url of the requested chart */
    getChartPngUrl(chart, dayChart = true) {
        return WT_Wait.awaitGenerator(this, void 0, void 0, function* () {
            if (chart !== undefined) {
                let success = yield this.validateToken();
                if (!success) {
                    throw (WT_NavigraphNetworkAPI.Error.ACCESS_DENIED);
                }
                const url = `https://charts.api.navigraph.com/2/airports/${chart.icao_airport_identifier}/signedurls/${dayChart ? chart.file_day : chart.file_night}`;
                const urlResp = yield this.sendRequest(url, "get", null, true);
                return urlResp.data;
            }
            return "";
        });
    }
    /**
     * Used to encapsulate requests to navigraph
     * @param path The url the request points to
     * @param method "GET" or "POST"
     * @param form A map of data to send in the request body
     * @param auth A boolean indicating if the auth token should be used for this request
     */
    sendRequest(path, method, form = null, auth = false) {
        return WT_Wait.awaitGenerator(this, void 0, void 0, function* () {
            const formData = new Map();
            formData.set(LZUTF8.decompress(WT_NavigraphNetworkAPI.FORM_KEYS[0], { inputEncoding: "StorageBinaryString" }), LZUTF8.decompress(this._magicStrings[0], { inputEncoding: "StorageBinaryString" }));
            formData.set(LZUTF8.decompress(WT_NavigraphNetworkAPI.FORM_KEYS[1], { inputEncoding: "StorageBinaryString" }), LZUTF8.decompress(this._magicStrings[1], { inputEncoding: "StorageBinaryString" }));
            if (form !== null) {
                form.forEach((v, k) => {
                    formData.set(k, v);
                });
            }
            const options = {
                ignoreCache: false,
                headers: {
                    Accept: 'application/json, text/javascript, text/plain',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                // default max duration for a request
                timeout: 10000,
            };
            if (auth) {
                options.headers["Authorization"] = "Bearer " + this.accessToken;
            }
            const response = yield WT_URLRequest.request(method, path, null, formData, options);
            return response;
        });
    }
}
WT_NavigraphNetworkAPI.REFRESH_TOKEN_KEY = "WT_NG_REFRESH_TOKEN";
WT_NavigraphNetworkAPI.ACC_TOKEN_KEY = "WT_NG_ACC_TOKEN";
/**
 * @enum {String}
 */
WT_NavigraphNetworkAPI.Error = {
    ACCESS_DENIED: "Access denied",
    AUTH_FAILED: "Authorization failed"
}
WT_NavigraphNetworkAPI.FORM_KEYS = [
    "ㆶᩙⷎ䗶䬠耂老",
    "ㆶᩙⷎ䗷ᬫ෉䫨耂老"
];

WT_NavigraphNetworkAPI.MAGIC_STRINGS_G3000 = [
    "㮺୙晦\u0303耂耀",
    "∧娒ै╃↙慐滦欶ᦪᄝ䭍㐔㦛ⶭ⒈焹ㄼ䀀耀"
]

/**
 * @typedef WT_NavigraphChartDefinition
 * @property {String} file_day
 * @property {String} file_night
 * @property {String} thumb_day
 * @property {String} thumb_night
 * @property {String} icao_airport_identifier
 * @property {String} id
 * @property {String} ext_id
 * @property {String} file_name
 * @property {{code:String, category:String, details:String, precision:String, section:String}} type
 * @property {String} index_number
 * @property {String} procedure_identifier
 * @property {String} action
 * @property {String} revision_date
 * @property {String} effective_date
 * @property {String} trim_size
 * @property {Boolean} georef
 * @property {Number[]} bbox_local
 * @property {{bbox_local:Number[], bbox_geo:Number[]}} planview
 * @property {{bbox_local:Number[]}[]} insets
 * @property {String[]} procedure_code
 * @property {String[]} runway
 * @property {String[]} route_id
 * @property {Boolean} std_visibility
 * @property {Boolean} cao_visibility
 * @property {Boolean} vfr_visibility
 * @property {Number} visibility
 */

class WT_NavigraphChart {
}
/**
 * @enum
 */
WT_NavigraphChart.BoundsIndex = {
    LEFT: 0,
    TOP: 3,
    RIGHT: 2,
    BOTTOM: 1
};

class WT_NavigraphChartOperations {
    /**
     * Retrieves the ident string of the airport to which a chart belongs from the ID of the chart.
     * @param {String} chartID - the ID of the chart.
     * @returns {String} the ident string of the airport to which the chart belongs.
     */
    static getAirportIdentFromID(chartID) {
        return chartID.substring(0, 4);
    }

    /**
     * Retrieves the airport diagram chart definition from a list of charts belonging to an airport. Returns
     * undefined if the airport diagram chart definition cannot be found.
     * @param {WT_NavigraphChartDefinition[]} chartDefs - the list of charts belonging to the airport.
     * @returns {WT_NavigraphChartDefinition} the airport diagram chart definition.
     */
    static findAirportDiagram(chartDefs) {
        return chartDefs.find(chartDef => chartDef.type.code === "AP");
    }

    /**
     * Retrieves the chart definition associated with a specific departure procedure from a list of charts belonging
     * to an airport. Returns undefined if an associated chart definition cannot be found.
     * @param {WT_NavigraphChartDefinition[]} chartDefs - the list of charts belonging to the airport.
     * @param {WT_Departure} departure - a departure procedure.
     * @returns {WT_NavigraphChartDefinition} the chart definition associated with the departure procedure.
     */
    static findDepartureChart(chartDefs, departure) {
        return departure ? chartDefs.find(chartDef => chartDef.type.section === "DEP" && chartDef.procedure_code[0] === departure.name) : undefined;
    }

    /**
     * Checks if a chart definition is associated with a specific departure procedure.
     * @param {WT_NavigraphChartDefinition} chartDef - a chart definition.
     * @param {WT_Departure} departure - a departure procedure.
     * @returns {Boolean} whether the chart definition and departure procedure are associated with each other.
     */
    static doesChartMatchDeparture(chartDef, departure) {
        return chartDef && departure && chartDef.icao_airport_identifier === departure.airport.ident && chartDef.type.section === "DEP" && chartDef.procedure_code[0] === departure.name;
    }

    /**
     * Retrieves the chart definition associated with a specific arrival procedure from a list of charts belonging
     * to an airport. Returns undefined if an associated chart definition cannot be found.
     * @param {WT_NavigraphChartDefinition[]} chartDefs - the list of charts belonging to the airport.
     * @param {WT_Arrival} arrival - an arrival procedure.
     * @returns {WT_NavigraphChartDefinition} the chart definition associated with the arrival procedure.
     */
    static findArrivalChart(chartDefs, arrival) {
        return arrival ? chartDefs.find(chartDef => chartDef.type.section === "ARR" && chartDef.procedure_code[0] === arrival.name) : undefined;
    }

    /**
     * Checks if a chart definition is associated with a specific arrival procedure.
     * @param {WT_NavigraphChartDefinition} chartDef - a chart definition.
     * @param {WT_Arrival} arrival - an arrival procedure.
     * @returns {Boolean} whether the chart definition and arrival procedure are associated with each other.
     */
    static doesChartMatchArrival(chartDef, arrival) {
        return chartDef && arrival && chartDef.icao_airport_identifier === arrival.airport.ident && chartDef.type.section === "ARR" && chartDef.procedure_code[0] === arrival.name;
    }

    /**
     *
     * @param {WT_Approach} approach
     * @returns {String}
     */
    static _getApproachChartCodePrefix(approach) {
        if (approach) {
            switch (approach.type) {
                case WT_Approach.Type.ILS:
                    return "I";
                case WT_Approach.Type.LOC:
                    return approach.runway ? "L" : "LDM";
                case WT_Approach.Type.RNAV:
                    return approach.runway ? "R" : "RNV";
                case WT_Approach.Type.VOR:
                    return approach.runway ? "V" : "VOR";
                case WT_Approach.Type.NDB:
                    return approach.runway ? "N" : "NDB";
                case WT_Approach.Type.LDA:
                    return "X";
            }
        }
        return "";
    }

    /**
     *
     * @param {WT_Approach} approach
     * @returns {String}
     */
    static _getApproachChartCodeSuffix(approach) {
        if (approach) {
            let letterMatch = approach.name.match(/( |-)([A-Z])( |$)/);
            if (letterMatch) {
                return letterMatch[2];
            }
        }
        return "";
    }

    /**
     * Retrieves the chart definition associated with a specific approach procedure from a list of charts belonging
     * to an airport. Returns undefined if an associated chart definition cannot be found.
     * @param {WT_NavigraphChartDefinition[]} chartDefs - the list of charts belonging to the airport.
     * @param {WT_Approach} approach - an approach procedure.
     * @returns {WT_NavigraphChartDefinition} the chart definition associated with the approach procedure.
     */
    static findApproachChart(chartDefs, approach) {
        if (!approach) {
            return undefined;
        }

        let prefix = WT_NavigraphChartOperations._getApproachChartCodePrefix(approach);
        let suffix = WT_NavigraphChartOperations._getApproachChartCodeSuffix(approach);
        let code = `${prefix}${approach.runway ? approach.runway.designationFull : ""}${suffix}`;
        let codeAlt = `${prefix}${approach.runway ? approach.runway.designationFull : ""}-${suffix}`;
        return chartDefs.find(chartDef => chartDef.type.section === "APP" && chartDef.procedure_code.some(candidate => candidate === code || candidate === codeAlt));
    }

    /**
     * Checks if a chart definition is associated with a specific approach procedure.
     * @param {WT_NavigraphChartDefinition} chartDef - a chart definition.
     * @param {WT_Approach} approach - an approach procedure.
     * @returns {Boolean} whether the chart definition and approach procedure are associated with each other.
     */
    static doesChartMatchApproach(chartDef, approach) {
        if (!chartDef || !approach || chartDef.icao_airport_identifier !== approach.airport.ident || chartDef.type.section !== "APP") {
            return false;
        }

        let prefix = WT_NavigraphChartOperations._getApproachChartCodePrefix(approach);
        let suffix = WT_NavigraphChartOperations._getApproachChartCodeSuffix(approach);
        let code = `${prefix}${approach.runway ? approach.runway.designationFull : ""}${suffix}`;
        let codeAlt = `${prefix}${approach.runway ? approach.runway.designationFull : ""}-${suffix}`;
        return chartDef.procedure_code.some(candidate => candidate === code || candidate === codeAlt);
    }
}