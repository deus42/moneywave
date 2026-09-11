export const migration0009 = {
  version: 9,
  name: "personal_spending_taxonomy",
  sql: `
    UPDATE categories SET display_name = 'Дохід' WHERE code = 'personal_income';
    UPDATE categories SET display_name = 'Житло' WHERE code = 'housing';
    UPDATE categories SET display_name = 'Їжа' WHERE code = 'food';
    UPDATE categories SET display_name = 'Транспорт' WHERE code = 'transport';
    UPDATE categories SET display_name = 'Здоровʼя' WHERE code = 'health';
    UPDATE categories SET display_name = 'Розваги' WHERE code = 'entertainment';
    UPDATE categories SET display_name = 'Інше' WHERE code = 'other';

    INSERT INTO categories (id, parent_id, scope, code, display_name, editable) VALUES
      ('personal-groceries', 'personal-food', 'personal', 'groceries', 'Продукти', 1),
      ('personal-dining', 'personal-food', 'personal', 'dining', 'Кафе й ресторани', 1),
      ('personal-rent-mortgage', 'personal-housing', 'personal', 'rent_mortgage', 'Оренда та іпотека', 1),
      ('personal-utilities', 'personal-housing', 'personal', 'utilities', 'Комунальні послуги', 1),
      ('personal-home', 'personal-housing', 'personal', 'home', 'Дім', 1),
      ('personal-public-transport', 'personal-transport', 'personal', 'public_transport', 'Громадський транспорт', 1),
      ('personal-taxi', 'personal-transport', 'personal', 'taxi', 'Таксі', 1),
      ('personal-fuel', 'personal-transport', 'personal', 'fuel', 'Пальне', 1),
      ('personal-parking', 'personal-transport', 'personal', 'parking', 'Паркування', 1),
      ('personal-pharmacy', 'personal-health', 'personal', 'pharmacy', 'Аптеки', 1),
      ('personal-medical', 'personal-health', 'personal', 'medical', 'Медицина', 1),
      ('personal-fitness', 'personal-health', 'personal', 'fitness', 'Спорт і фітнес', 1),
      ('personal-streaming', 'personal-entertainment', 'personal', 'streaming', 'Стримінг', 1),
      ('personal-culture', 'personal-entertainment', 'personal', 'culture', 'Кіно й культура', 1),
      ('personal-gaming', 'personal-entertainment', 'personal', 'gaming', 'Ігри', 1),
      ('personal-shopping', NULL, 'personal', 'shopping', 'Покупки', 1),
      ('personal-clothing', 'personal-shopping', 'personal', 'clothing', 'Одяг і взуття', 1),
      ('personal-electronics', 'personal-shopping', 'personal', 'electronics', 'Техніка', 1),
      ('personal-travel', NULL, 'personal', 'travel', 'Подорожі', 1),
      ('personal-education', NULL, 'personal', 'education', 'Освіта', 1),
      ('personal-care', NULL, 'personal', 'personal_care', 'Особистий догляд', 1),
      ('personal-subscriptions', NULL, 'personal', 'subscriptions', 'Підписки', 1),
      ('personal-gifts-charity', NULL, 'personal', 'gifts_charity', 'Подарунки й благодійність', 1),
      ('personal-cash', NULL, 'personal', 'cash', 'Готівка', 1),
      ('personal-bank-fees', NULL, 'personal', 'bank_fees', 'Банківські комісії', 1),
      ('personal-transfers', NULL, 'personal', 'transfers', 'Перекази', 1);
  `,
} as const;
