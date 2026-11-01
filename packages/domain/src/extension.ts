/** Native messaging host name; the browser launches the companion under it. */
export const HOST_NAME = 'pr_review'

/** Public key in the extension manifest. It pins the extension id, so the host can allow only that origin. */
export const EXTENSION_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1yN5/68SGiaPA9k7oebE8zV2xW8KSsoo+McGib5+UB/m4eLPqNxjWKmCmqecrCEIHTqSMD316jRK6yQ/ovkXLoz52cdNlIrQO2xWGk5WnqbQd4dK/4XAkEQFMyu6DF8KoTSBfV7a+DvhuPgERq5yvRptQiuALtsANuQo/bUB8bCBIYqtVzWdPeyEcd+d5p7811TEU5eB1x2Vme9MmPGjUYFGNblA46WsqUSA1PbmUkEeXI7MolDiAkl727MRRuRGGGtyVuDsF6UkZf9ragc61lkk4eZuGeodsujUUwVs5MGg7FeXgsbCYtLnX3vpcq1PzSUeZl8RMlC6chfjjyGCpQIDAQAB'

/** Firefox extension id (`browser_specific_settings.gecko.id`); the Firefox host manifest allows only it. */
export const GECKO_ID = 'pr-review@jorrinkievit'
