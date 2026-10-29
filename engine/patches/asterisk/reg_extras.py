import sys

# PATCH_REG_EXTRAS: optional REGISTER additions that some IMS cores expect from a native UE,
# each switched on per line through the engine environment (render.py -> engine.env ->
# entrypoint.sh exports -> Asterisk process). Unset = stock behaviour.
#
#   VOWIFI_REG_GEO_COUNTRY=<ISO 3166 alpha-2>
#       Location by value in every REGISTER (RFC 6442): "Geolocation: <cid:...>",
#       "Geolocation-Routing: yes", Content-ID and an application/pidf+xml body (RFC 4119/5139)
#       whose civic address carries only the country. An iPhone on MTS RU VoWiFi sends this
#       (Geolocation + PIDF-LO with civicAddress) in its REGISTER; our client did not, and MTS
#       network-rejects the registration ~220 ms after the 200 OK.
#   VOWIFI_REG_SRVCC_TAGS=1
#       Add +g.3gpp.mid-call;+g.3gpp.srvcc-alerting;+g.3gpp.ps2cs-srvcc-orig-pre-alerting to the
#       REGISTER Contact (TS 24.237 SRVCC capability indication), as the iPhone does. The stock
#       client only advertises them on INVITE.

GEO_FN = r'''
/* PATCH_REG_EXTRAS */
static void volte_add_geolocation(struct sip_outbound_registration_client_state *client_state,
	pjsip_tx_data *tdata)
{
	static const pj_str_t STR_GEOLOCATION = { "Geolocation", 11 };
	const char *country = getenv("VOWIFI_REG_GEO_COUNTRY");
	pjsip_to_hdr *to;
	char entity[256], cid[64], value[96], stamp[32], xml[1536];
	pj_str_t type, subtype, text;
	pj_ssize_t len;
	time_t now;
	struct tm tm;

	if (!client_state->volte || ast_strlen_zero(country)
		|| pjsip_method_cmp(&tdata->msg->line.req.method, &pjsip_register_method)) {
		return;
	}
	/* The authenticated REGISTER is cloned from the challenged one: add only once. */
	if (pjsip_msg_find_hdr_by_name(tdata->msg, &STR_GEOLOCATION, NULL) || tdata->msg->body) {
		return;
	}

	to = PJSIP_MSG_TO_HDR(tdata->msg);
	len = to ? pjsip_uri_print(PJSIP_URI_IN_FROMTO_HDR, pjsip_uri_get_uri(to->uri), entity, sizeof(entity) - 1) : -1;
	if (len <= 0) {
		ast_copy_string(entity, "sip:unknown", sizeof(entity));
	} else {
		entity[len] = '\0';
	}

	now = time(NULL);
	gmtime_r(&now, &tm);
	strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%SZ", &tm);
	snprintf(cid, sizeof(cid), "loc%08lx@ue.ims", (unsigned long) ast_random());

	snprintf(xml, sizeof(xml),
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\r\n"
		"<presence xmlns=\"urn:ietf:params:xml:ns:pidf\""
		" xmlns:dm=\"urn:ietf:params:xml:ns:pidf:data-model\""
		" xmlns:gp=\"urn:ietf:params:xml:ns:pidf:geopriv10\""
		" xmlns:cl=\"urn:ietf:params:xml:ns:pidf:geopriv10:civicAddr\""
		" entity=\"%s\">\r\n"
		"<dm:device id=\"Wifi\">\r\n"
		"<gp:geopriv>\r\n"
		"<gp:location-info>\r\n"
		"<cl:civicAddress>\r\n"
		"<cl:country>%s</cl:country>\r\n"
		"</cl:civicAddress>\r\n"
		"</gp:location-info>\r\n"
		"<gp:usage-rules/>\r\n"
		"</gp:geopriv>\r\n"
		"<dm:timestamp>%s</dm:timestamp>\r\n"
		"</dm:device>\r\n"
		"</presence>\r\n",
		entity, country, stamp);

	snprintf(value, sizeof(value), "<cid:%s>", cid);
	ast_sip_add_header(tdata, "Geolocation", value);
	ast_sip_add_header(tdata, "Geolocation-Routing", "yes");
	snprintf(value, sizeof(value), "<%s>", cid);
	ast_sip_add_header(tdata, "Content-ID", value);

	pj_cstr(&type, "application");
	pj_cstr(&subtype, "pidf+xml");
	pj_strdup2(tdata->pool, &text, xml);
	tdata->msg->body = pjsip_msg_body_create(tdata->pool, &type, &subtype, &text);
	ast_debug(1, "VoLTE: added Geolocation (country=%s) to REGISTER\n", country);
}

'''


def replace_once(s, old, new, what):
    n = s.count(old)
    if n != 1:
        print("PATTERN NOT FOUND (%d matches): %s" % (n, what)); sys.exit(1)
    return s.replace(old, new)


reg = '/home/asterisk-build/asterisk/res/res_pjsip_outbound_registration.c'
s = open(reg).read()
if 'PATCH_REG_EXTRAS' not in s:
    s = replace_once(s, 'static pj_status_t registration_client_send(struct sip_outbound_registration_client_state *client_state,\n',
                     GEO_FN + 'static pj_status_t registration_client_send(struct sip_outbound_registration_client_state *client_state,\n',
                     'registration_client_send definition')
    s = replace_once(s, '\t/* Add Security-Verify or Security-Client headers */\n\tadd_security_headers(client_state, tdata);\n',
                     '\t/* Add Security-Verify or Security-Client headers */\n\tadd_security_headers(client_state, tdata);\n'
                     '\tvolte_add_geolocation(client_state, tdata);\n',
                     'add_security_headers call')
    open(reg, 'w').write(s)

volte = '/home/asterisk-build/asterisk/res/res_pjsip_outbound_registration/volte.c'
s = open(volte).read()
if 'PATCH_REG_EXTRAS' not in s:
    s = replace_once(s,
                     '\tif (sms_enabled)\n\t\tsprintf(strchr(contact, \'\\0\'), ";+g.3gpp.smsip");\n\n\treturn contact;\n',
                     '\tif (sms_enabled)\n\t\tsprintf(strchr(contact, \'\\0\'), ";+g.3gpp.smsip");\n'
                     '\t/* PATCH_REG_EXTRAS: SRVCC capability tags in the REGISTER Contact (opt-in). */\n'
                     '\tif (!ast_strlen_zero(getenv("VOWIFI_REG_SRVCC_TAGS")) && strcmp(getenv("VOWIFI_REG_SRVCC_TAGS"), "0"))\n'
                     '\t\tsprintf(strchr(contact, \'\\0\'), ";+g.3gpp.mid-call;+g.3gpp.srvcc-alerting;+g.3gpp.ps2cs-srvcc-orig-pre-alerting");\n'
                     '\n\treturn contact;\n',
                     'volte_add_contact_params smsip/return')
    open(volte, 'w').write(s)

print("patched OK (REGISTER Geolocation + SRVCC contact tags, env-switchable)")
