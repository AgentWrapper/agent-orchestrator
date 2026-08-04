import { useRouter } from "expo-router";
import { LanguagePickerSheet } from "../../lib/LanguagePickerSheet";
import { useLocale } from "../../lib/i18n";

export default function LanguageSheetRoute() {
	const router = useRouter();
	const { locale, setLocale } = useLocale();

	return <LanguagePickerSheet locale={locale} onSelect={setLocale} onClose={() => router.back()} />;
}
