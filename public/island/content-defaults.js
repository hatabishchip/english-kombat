// ЕДИНЫЙ ИСТОЧНИК КОНТЕНТА ОСТРОВА (дефолты).
// Реальный контент редактирует Роман в /island/admin.html -> хранится на сервере (KV),
// игра и админка мержат серверный контент ПОВЕРХ этих дефолтов.
window.DEFAULT_CONTENT = {
  // Кружки Романа в онбординге. text - что говорит (TTS-плейсхолдер),
  // video - URL реального кружка (когда Роман запишет; пусто = озвучка текстом).
  circles: {
    c1: {
      who: 'Роман',
      text: 'Йо! Это Роман. Это игра, где ты учишь английский, кидаясь бананами. Давай за минуту настрою игру под тебя. Окей?',
      video: ''
    },
    c2: {
      who: 'Роман',
      text: 'Твой уровень примерно понятен. Сейчас небольшая настройка - и будешь готов. Лови кнопку старта. Я пока на перекур - пробуй и маякуй в чате, встретимся как пройдёшь. Готов?',
      video: ''
    }
  },
  // Определение уровня: человек выбирает ОДНУ фразу, которую понимает/может перевести.
  probes: [
    { en: 'Hello! How are you?',                             level: 'beginner' },
    { en: 'I have been learning English for two years',      level: 'mid' },
    { en: 'If I had known earlier, I would have started sooner', level: 'advanced' }
  ],
  probeNone: 'Ничего не понял 🤷',   // кнопка «ничего» -> beginner
  // 4 локации острова, фразы по уровням (ru, en, answers - варианты засчитываемых ответов)
  locations: [
    { key: 'changgu', title: 'Пляж Чангу', emoji: '🏄', levels: {
      beginner: [
        { ru: 'Одну доску, пожалуйста', en: 'One board, please', ans: ['one board please','one board','a board please'] },
        { ru: 'Сколько это стоит?', en: 'How much is it?', ans: ['how much is it','how much','how much does it cost'] },
        { ru: 'Вода тёплая?', en: 'Is the water warm?', ans: ['is the water warm','the water is warm','is water warm'] },
        { ru: 'Мне нравится это место', en: 'I like this place', ans: ['i like this place','i love this place'] }
      ],
      mid: [
        { ru: 'Я хочу взять урок сёрфинга', en: 'I want to take a surf lesson', ans: ['i want to take a surf lesson','i want a surf lesson','i want to take surf lesson'] },
        { ru: 'Во сколько сегодня закат?', en: 'What time is the sunset today?', ans: ['what time is the sunset today','what time is sunset today','when is the sunset today'] },
        { ru: 'Здесь сильные волны?', en: 'Are the waves strong here?', ans: ['are the waves strong here','are waves strong here','is the waves strong'] },
        { ru: 'Можно оставить вещи здесь?', en: 'Can I leave my things here?', ans: ['can i leave my things here','can i leave my stuff here','may i leave my things here'] }
      ],
      advanced: [
        { ru: 'Я бы хотел арендовать доску на пару часов', en: 'I would like to rent a board for a couple of hours', ans: ['i would like to rent a board for a couple of hours','i would like to rent a board for two hours','i d like to rent a board for a couple of hours'] },
        { ru: 'Если волны будут слишком большие, я вернусь позже', en: 'If the waves are too big, I will come back later', ans: ['if the waves are too big i will come back later','if waves are too big i will come back later'] },
        { ru: 'Не подскажете, где лучшее место для новичков?', en: 'Could you tell me the best spot for beginners?', ans: ['could you tell me the best spot for beginners','can you tell me the best spot for beginners','where is the best spot for beginners'] },
        { ru: 'Я занимаюсь сёрфингом с прошлого лета', en: 'I have been surfing since last summer', ans: ['i have been surfing since last summer','i surf since last summer'] }
      ]
    }},
    { key: 'ubud', title: 'Кафе в Убуде', emoji: '☕', levels: {
      beginner: [
        { ru: 'Один кофе, пожалуйста', en: 'One coffee, please', ans: ['one coffee please','one coffee','a coffee please','coffee please'] },
        { ru: 'Можно меню?', en: 'Can I have the menu?', ans: ['can i have the menu','the menu please','menu please','can i have menu'] },
        { ru: 'Это очень вкусно', en: 'It is very tasty', ans: ['it is very tasty','its very tasty','very tasty','it is very delicious'] },
        { ru: 'Счёт, пожалуйста', en: 'The bill, please', ans: ['the bill please','bill please','check please','the check please'] }
      ],
      mid: [
        { ru: 'Какой кофе вы посоветуете?', en: 'What coffee do you recommend?', ans: ['what coffee do you recommend','which coffee do you recommend','what do you recommend'] },
        { ru: 'Можно мне без сахара?', en: 'Can I have it without sugar?', ans: ['can i have it without sugar','without sugar please','no sugar please','can i have without sugar'] },
        { ru: 'Здесь есть вай-фай?', en: 'Is there wi-fi here?', ans: ['is there wifi here','is there wi fi here','do you have wifi','do you have wi fi'] },
        { ru: 'Я подожду за столиком у окна', en: 'I will wait at the table by the window', ans: ['i will wait at the table by the window','i wait at the table by the window'] }
      ],
      advanced: [
        { ru: 'Я бы взял то же самое, что и вчера', en: 'I would take the same as yesterday', ans: ['i would take the same as yesterday','i will take the same as yesterday','same as yesterday please'] },
        { ru: 'Если можно, сделайте кофе покрепче', en: 'Could you make the coffee stronger, please?', ans: ['could you make the coffee stronger please','can you make the coffee stronger','make the coffee stronger please'] },
        { ru: 'Посоветуйте что-нибудь из местной кухни', en: 'Could you recommend something from the local cuisine?', ans: ['could you recommend something from the local cuisine','can you recommend something local','recommend something from local cuisine'] },
        { ru: 'Здесь так уютно, что не хочется уходить', en: 'It is so cozy here that I do not want to leave', ans: ['it is so cozy here that i do not want to leave','its so cozy here i dont want to leave','so cozy here i do not want to leave'] }
      ]
    }},
    { key: 'denpasar', title: 'Аренда байка · Денпасар', emoji: '🛵', levels: {
      beginner: [
        { ru: 'Мне нужен байк', en: 'I need a bike', ans: ['i need a bike','i need bike','i need a scooter'] },
        { ru: 'На один день', en: 'For one day', ans: ['for one day','one day','for a day'] },
        { ru: 'Где мой шлем?', en: 'Where is my helmet?', ans: ['where is my helmet','where is helmet','my helmet where'] },
        { ru: 'Бак полный?', en: 'Is the tank full?', ans: ['is the tank full','is tank full','the tank is full'] }
      ],
      mid: [
        { ru: 'Сколько стоит аренда на неделю?', en: 'How much is the rent for a week?', ans: ['how much is the rent for a week','how much for a week','how much is rent for week'] },
        { ru: 'Мне нужен байк побольше', en: 'I need a bigger bike', ans: ['i need a bigger bike','i need bigger bike','a bigger bike please'] },
        { ru: 'Куда вернуть байк вечером?', en: 'Where do I return the bike in the evening?', ans: ['where do i return the bike in the evening','where to return the bike','where do i return the bike'] },
        { ru: 'Можно оплатить картой?', en: 'Can I pay by card?', ans: ['can i pay by card','can i pay with card','pay by card'] }
      ],
      advanced: [
        { ru: 'Что мне делать, если байк сломается по дороге?', en: 'What should I do if the bike breaks down on the road?', ans: ['what should i do if the bike breaks down on the road','what do i do if the bike breaks down','what should i do if bike breaks down'] },
        { ru: 'Я бы хотел байк с полной страховкой', en: 'I would like a bike with full insurance', ans: ['i would like a bike with full insurance','i want a bike with full insurance','a bike with full insurance please'] },
        { ru: 'Если я верну его раньше, будет ли скидка?', en: 'If I return it earlier, will there be a discount?', ans: ['if i return it earlier will there be a discount','if i return it early will i get a discount','will there be a discount if i return it earlier'] },
        { ru: 'Покажите, как открывается багажник', en: 'Could you show me how the trunk opens?', ans: ['could you show me how the trunk opens','show me how the trunk opens','how does the trunk open'] }
      ]
    }},
    { key: 'uluwatu', title: 'Закат-бар · Улувату', emoji: '🌅', levels: {
      beginner: [
        { ru: 'Один сок, пожалуйста', en: 'One juice, please', ans: ['one juice please','one juice','a juice please','juice please'] },
        { ru: 'Какой красивый закат!', en: 'What a beautiful sunset!', ans: ['what a beautiful sunset','beautiful sunset','so beautiful sunset'] },
        { ru: 'Можно столик у края?', en: 'Can we have a table at the edge?', ans: ['can we have a table at the edge','a table at the edge please','table at the edge'] },
        { ru: 'Я счастлив', en: 'I am happy', ans: ['i am happy','im happy','i m happy'] }
      ],
      mid: [
        { ru: 'Во сколько здесь начинается музыка?', en: 'What time does the music start here?', ans: ['what time does the music start here','when does the music start','what time does music start'] },
        { ru: 'Сфотографируете нас, пожалуйста?', en: 'Could you take a photo of us, please?', ans: ['could you take a photo of us please','can you take a photo of us','take a photo of us please'] },
        { ru: 'Это лучший вечер на Бали', en: 'This is the best evening in Bali', ans: ['this is the best evening in bali','the best evening in bali','this is the best evening on bali'] },
        { ru: 'Давай останемся до темноты', en: 'Let us stay until dark', ans: ['let us stay until dark','lets stay until dark','let s stay until dark'] }
      ],
      advanced: [
        { ru: 'Я никогда не видел такого заката, как этот', en: 'I have never seen a sunset like this one', ans: ['i have never seen a sunset like this one','i have never seen a sunset like this','never seen a sunset like this'] },
        { ru: 'Если бы я мог, я бы остался здесь навсегда', en: 'If I could, I would stay here forever', ans: ['if i could i would stay here forever','if i could i d stay here forever'] },
        { ru: 'Посоветуйте коктейль, который стоит попробовать', en: 'Could you suggest a cocktail worth trying?', ans: ['could you suggest a cocktail worth trying','can you suggest a cocktail worth trying','suggest a cocktail worth trying'] },
        { ru: 'Этот вид стоил всей поездки', en: 'This view was worth the whole trip', ans: ['this view was worth the whole trip','the view was worth the whole trip','this view is worth the whole trip'] }
      ]
    }}
  ],
  // Боевые фразы Worms-арены
  battle: [
    { ru: 'Получай банан!', en: 'Take this banana!', ans: ['take this banana','take the banana','take this'] },
    { ru: 'Я тебя достану', en: 'I will get you', ans: ['i will get you','i ll get you','i will catch you'] },
    { ru: 'Это мой остров', en: 'This is my island', ans: ['this is my island','it is my island','its my island'] },
    { ru: 'Ты не спрячешься', en: 'You cannot hide', ans: ['you cannot hide','you can t hide','you cant hide'] },
    { ru: 'Огонь!', en: 'Fire!', ans: ['fire','open fire'] },
    { ru: 'Смотри и учись', en: 'Watch and learn', ans: ['watch and learn','look and learn'] },
    { ru: 'Слишком легко', en: 'Too easy', ans: ['too easy','so easy','its too easy'] },
    { ru: 'Я чемпион', en: 'I am the champion', ans: ['i am the champion','i m the champion','i am champion'] },
    { ru: 'Беги, пока можешь', en: 'Run while you can', ans: ['run while you can','run when you can'] },
    { ru: 'Кокос летит к тебе', en: 'Coconut is coming', ans: ['coconut is coming','the coconut is coming','coconut coming'] },
    { ru: 'Не зли меня', en: 'Do not make me angry', ans: ['do not make me angry','don t make me angry','dont make me angry'] },
    { ru: 'Победа будет моей', en: 'Victory will be mine', ans: ['victory will be mine','the victory will be mine','victory is mine'] }
  ]
};
